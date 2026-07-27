from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from PyQt6.QtCore import QObject, QThread, Qt, pyqtSignal, pyqtSlot
from PyQt6.QtGui import QAction, QColor, QIcon
from PyQt6.QtWidgets import (
    QApplication,
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QMenu,
    QPushButton,
    QProgressBar,
    QPlainTextEdit,
    QScrollArea,
    QSizePolicy,
    QTabWidget,
    QTextEdit,
    QToolBar,
    QToolButton,
    QVBoxLayout,
    QWidget,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from packages.shared_core import (
    PipelineConfig,
    SUPPORTED_EXTS,
    VIDEO_EXTS,
    collect_environment_checks,
    expand_inputs,
    process_many,
)
from apps.desktop.meta import APP_DESCRIPTION, APP_NAME, APP_VERSION

APP_RUNTIME_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else REPO_ROOT
DEFAULT_OUTPUT_DIR = APP_RUNTIME_ROOT / "sandbox" / "gui-output"
JOBS_ROOT = APP_RUNTIME_ROOT / "outputs" / "work" / "jobs"
GUI_PRESET_PATH = APP_RUNTIME_ROOT / "sandbox" / "gui-preset.json"
GUI_STATE_PATH = APP_RUNTIME_ROOT / "sandbox" / "gui-state.json"
QUEUE_STATE_PATH = APP_RUNTIME_ROOT / "sandbox" / "gui-queue.json"
DEFAULT_LOG_EXPORT_PATH = APP_RUNTIME_ROOT / "sandbox" / "gui-log.txt"
APP_ICON_PATH = REPO_ROOT / "assets" / "video2text.ico"


class DropListWidget(QListWidget):
    files_dropped = pyqtSignal(list)

    def __init__(self) -> None:
        super().__init__()
        self.setAcceptDrops(True)
        self.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)

    def dragEnterEvent(self, event) -> None:  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event) -> None:  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event) -> None:  # noqa: N802
        paths: list[str] = []
        for url in event.mimeData().urls():
            local = url.toLocalFile()
            if local:
                paths.append(local)
        if paths:
            self.files_dropped.emit(paths)
            event.acceptProposedAction()
        else:
            event.ignore()


class PipelineWorker(QObject):
    log_emitted = pyqtSignal(str)
    file_started = pyqtSignal(str)
    stage_changed = pyqtSignal(str, str)
    file_finished = pyqtSignal(str, str)
    results_ready = pyqtSignal(list)
    all_finished = pyqtSignal(int, str)

    def __init__(self, paths: list[str], output_format: str, translate: bool, output_dir: str) -> None:
        super().__init__()
        self.paths = paths
        self.output_format = output_format
        self.translate = translate
        self.output_dir = output_dir

    @pyqtSlot()
    def run(self) -> None:
        try:
            resolved_paths = expand_inputs(self.paths)
            if not resolved_paths:
                self.all_finished.emit(1, "No supported media files found.")
                return

            path_order = {str(path): index for index, path in enumerate(resolved_paths)}

            def log(message: str) -> None:
                self.log_emitted.emit(message)
                prefix = "=== Processing: "
                suffix = " ==="
                if message.startswith(prefix) and message.endswith(suffix):
                    source = message[len(prefix) : -len(suffix)]
                    self.file_started.emit(source)
                elif message.startswith("OK -> "):
                    pass
                elif message.startswith("FAIL -> "):
                    left, _, right = message.partition(": ")
                    failed_source = left.removeprefix("FAIL -> ").strip()
                    self.file_finished.emit(failed_source, f"Failed: {right or 'Unknown error'}")

            def stage_callback(source_path: Path, _stage: str, detail: str) -> None:
                self.stage_changed.emit(str(source_path), detail)

            config = PipelineConfig(
                output_format=self.output_format,
                translate=self.translate,
                output_dir=Path(self.output_dir) if self.output_dir else None,
            )
            results, failures = process_many(resolved_paths, config, log=log, stage_callback=stage_callback)

            result_payload = []
            for result in results:
                result_payload.append((str(result.source_path), str(result.output_path)))
                self.file_finished.emit(str(result.source_path), f"Done: {result.output_path.name}")
            self.results_ready.emit(result_payload)

            if failures:
                for source_path, exc in failures:
                    if str(source_path) not in path_order:
                        self.file_finished.emit(str(source_path), f"Failed: {exc}")
                self.all_finished.emit(1, f"{len(failures)} file(s) failed.")
            else:
                self.all_finished.emit(0, "Processing completed successfully.")
        except Exception as exc:  # noqa: BLE001
            self.log_emitted.emit(f"Fatal error: {exc}")
            self.all_finished.emit(1, str(exc))


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(f"{APP_NAME} {APP_VERSION}")
        if APP_ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(APP_ICON_PATH)))
        self.resize(1100, 760)
        self.worker_thread: QThread | None = None
        self.worker: PipelineWorker | None = None
        self.latest_results: dict[str, str] = {}
        self.completed_count = 0
        self.failed_count = 0
        self.total_count = 0
        self.preset_autosave_enabled = True
        self.queue_persistence_enabled = True
        self.last_environment_checks = []
        self.output_dir_manually_set = False
        self.last_auto_output_dir = str(DEFAULT_OUTPUT_DIR)
        self._build_ui()

    def _build_ui(self) -> None:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.setCentralWidget(scroll)

        root = QWidget()
        scroll.setWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(18, 18, 18, 18)
        outer.setSpacing(14)

        toolbar = QToolBar("Main")
        toolbar.setMovable(False)
        self.addToolBar(toolbar)

        add_files_action = QAction("Add Files", self)
        add_files_action.triggered.connect(self.select_files)
        self.add_files_action = add_files_action
        toolbar.addAction(add_files_action)

        add_folder_action = QAction("Add Folder", self)
        add_folder_action.triggered.connect(self.select_folder)
        self.add_folder_action = add_folder_action
        toolbar.addAction(add_folder_action)

        clear_action = QAction("Clear", self)
        clear_action.triggered.connect(self.clear_files)
        self.clear_action = clear_action

        restore_queue_action = QAction("Restore Queue", self)
        restore_queue_action.triggered.connect(self.restore_queue)

        save_preset_action = QAction("Save Preset", self)
        save_preset_action.triggered.connect(self.save_preset)

        load_preset_action = QAction("Load Preset", self)
        load_preset_action.triggered.connect(self.load_preset)

        export_log_action = QAction("Export Log", self)
        export_log_action.triggered.connect(self.export_log)

        cleanup_cache_action = QAction("Cleanup Cache", self)
        cleanup_cache_action.triggered.connect(self.cleanup_cache)

        other_menu = QMenu("Other", self)
        other_menu.addAction(clear_action)
        other_menu.addAction(restore_queue_action)
        other_menu.addAction(save_preset_action)
        other_menu.addAction(load_preset_action)
        other_menu.addAction(export_log_action)
        other_menu.addSeparator()
        other_menu.addAction(cleanup_cache_action)

        other_button = QToolButton(self)
        other_button.setText("Other")
        other_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        other_button.setMenu(other_menu)
        toolbar.addWidget(other_button)

        about_action = QAction("About", self)
        about_action.triggered.connect(self.show_about_dialog)
        toolbar.addAction(about_action)

        title = QLabel("Media To Transcript")
        title.setStyleSheet("font-size: 28px; font-weight: 700;")
        outer.addWidget(title)

        subtitle = QLabel(
            "Drop audio or video files here. Audio transcribes directly. "
            "Video extracts audio first, then runs the same transcript pipeline."
        )
        subtitle.setWordWrap(True)
        subtitle.setStyleSheet("color: #555; font-size: 13px;")
        outer.addWidget(subtitle)

        self.drop_frame = QFrame()
        self.drop_frame.setObjectName("dropFrame")
        self.drop_frame.setFrameShape(QFrame.Shape.StyledPanel)
        self.drop_frame.setStyleSheet(
            "#dropFrame { border: 2px solid #5f7adb; border-radius: 14px; background: #f7f9ff; }"
        )
        drop_layout = QVBoxLayout(self.drop_frame)
        drop_layout.setContentsMargins(16, 16, 16, 16)
        drop_layout.setSpacing(10)

        drop_hint_frame = QFrame()
        drop_hint_frame.setObjectName("dropHintFrame")
        drop_hint_frame.setFrameShape(QFrame.Shape.StyledPanel)
        drop_hint_frame.setStyleSheet(
            "#dropHintFrame { border: 2px dashed #7c98e8; border-radius: 10px; background: rgba(255, 255, 255, 0.55); }"
        )
        drop_hint_layout = QVBoxLayout(drop_hint_frame)
        drop_hint_layout.setContentsMargins(18, 10, 18, 10)
        drop_hint_layout.setSpacing(4)

        drop_label = QLabel("Drag files or folders into this area")
        drop_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        drop_label.setStyleSheet("font-size: 16px; font-weight: 600; color: #243b6b; background: transparent;")
        drop_hint_layout.addWidget(drop_label)

        helper = QLabel("Supported: m4a / mp3 / wav / mp4 / mov / mkv / avi / webm ...")
        helper.setAlignment(Qt.AlignmentFlag.AlignCenter)
        helper.setStyleSheet("color: #5a6b8b; background: transparent;")
        drop_hint_layout.addWidget(helper)

        drop_layout.addWidget(drop_hint_frame)

        self.file_list = DropListWidget()
        self.file_list.files_dropped.connect(self.add_paths)
        self.file_list.itemSelectionChanged.connect(self._update_retry_button)
        self.file_list.itemSelectionChanged.connect(self.refresh_task_details)
        self.file_list.itemDoubleClicked.connect(self.open_selected_result)
        self.file_list.setStyleSheet(
            "QListWidget { background: transparent; border: none; }"
            "QListWidget::item { background: rgba(255, 255, 255, 0.78); border: 1px solid #d7deef; "
            "border-radius: 8px; padding: 8px 10px; margin: 4px 0; }"
            "QListWidget::item:selected { background: #dbe7ff; border: 1px solid #7c98e8; color: #163b72; }"
        )
        self.file_list.setMinimumHeight(190)
        self.file_list.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.file_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.file_list.customContextMenuRequested.connect(self.show_file_context_menu)
        drop_layout.addWidget(self.file_list)

        outer.addWidget(self.drop_frame)

        controls = QFrame()
        controls.setFrameShape(QFrame.Shape.StyledPanel)
        controls.setStyleSheet("QFrame { background: #fcfcfd; border: 1px solid #e5e7eb; border-radius: 12px; }")
        controls_layout = QVBoxLayout(controls)
        controls_layout.setContentsMargins(16, 16, 16, 16)
        controls_layout.setSpacing(12)

        mode_row = QHBoxLayout()
        mode_label = QLabel("Output")
        mode_label.setFixedWidth(110)
        self.format_combo = QComboBox()
        self.format_combo.addItems(["txt", "srt"])
        self.format_combo.currentTextChanged.connect(self._persist_current_state)
        self.translate_checkbox = QCheckBox("Translate to Chinese")
        self.translate_checkbox.setChecked(True)
        self.translate_checkbox.toggled.connect(self._persist_current_state)
        mode_row.addWidget(mode_label)
        mode_row.addWidget(self.format_combo)
        mode_row.addSpacing(18)
        mode_row.addWidget(self.translate_checkbox)
        mode_row.addStretch(1)
        controls_layout.addLayout(mode_row)

        output_row = QHBoxLayout()
        output_label = QLabel("Output Folder")
        output_label.setFixedWidth(110)
        self.output_edit = QLineEdit(str(DEFAULT_OUTPUT_DIR))
        self.output_edit.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.output_edit.editingFinished.connect(self._handle_output_edit_finished)
        browse_output = QPushButton("Browse")
        browse_output.clicked.connect(self.choose_output_dir)
        output_row.addWidget(output_label)
        output_row.addWidget(self.output_edit)
        output_row.addWidget(browse_output)
        controls_layout.addLayout(output_row)

        actions_row = QHBoxLayout()
        self.run_button = QPushButton("Start Processing")
        self.run_button.clicked.connect(self.start_processing)
        self.run_button.setStyleSheet(
            "QPushButton { background: #163b72; color: white; border-radius: 8px; padding: 10px 18px; font-weight: 700; }"
            "QPushButton:disabled { background: #9aa7bd; }"
        )
        self.remove_selected_button = QPushButton("Remove Selected")
        self.remove_selected_button.clicked.connect(self.remove_selected)
        self.retry_button = QPushButton("Retry Selected")
        self.retry_button.clicked.connect(self.retry_selected)
        self.retry_button.setEnabled(False)
        self.select_failed_button = QPushButton("Select Failed")
        self.select_failed_button.clicked.connect(self.select_failed_items)
        self.select_failed_button.setEnabled(False)
        self.open_output_button = QPushButton("Open Output Folder")
        self.open_output_button.clicked.connect(self.open_output_folder)
        self.open_output_button.setEnabled(False)
        self.open_file_button = QPushButton("Open Result File")
        self.open_file_button.clicked.connect(self.open_selected_result)
        self.open_file_button.setEnabled(False)
        actions_row.addWidget(self.run_button)
        actions_row.addWidget(self.remove_selected_button)
        actions_row.addWidget(self.retry_button)
        actions_row.addWidget(self.select_failed_button)
        actions_row.addWidget(self.open_output_button)
        actions_row.addWidget(self.open_file_button)
        actions_row.addStretch(1)
        controls_layout.addLayout(actions_row)

        progress_row = QHBoxLayout()
        self.summary_label = QLabel("Ready")
        self.summary_label.setStyleSheet("font-weight: 600; color: #163b72;")
        self.current_stage_label = QLabel("No active task")
        self.current_stage_label.setStyleSheet("color: #5f6b7a;")
        progress_row.addWidget(self.summary_label)
        progress_row.addSpacing(12)
        progress_row.addWidget(self.current_stage_label, 1)
        controls_layout.addLayout(progress_row)

        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 1)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(True)
        self.progress_bar.setFormat("0 / 0")
        controls_layout.addWidget(self.progress_bar)

        outer.addWidget(controls)

        env_frame = QFrame()
        env_frame.setFrameShape(QFrame.Shape.StyledPanel)
        env_frame.setStyleSheet("QFrame { background: #fcfcfd; border: 1px solid #e5e7eb; border-radius: 12px; }")
        env_layout = QVBoxLayout(env_frame)
        env_layout.setContentsMargins(16, 16, 16, 16)
        env_layout.setSpacing(10)

        env_header = QHBoxLayout()
        env_title = QLabel("Environment Check")
        env_title.setStyleSheet("font-size: 16px; font-weight: 600;")
        self.env_summary_label = QLabel("Not checked yet")
        self.env_summary_label.setStyleSheet("color: #5f6b7a;")
        env_header.addWidget(env_title)
        env_header.addStretch(1)
        env_header.addWidget(self.env_summary_label)
        env_layout.addLayout(env_header)

        self.env_status_label = QLabel("Checks run automatically based on your queue and options.")
        self.env_status_label.setWordWrap(True)
        self.env_status_label.setStyleSheet("color: #374151;")
        env_layout.addWidget(self.env_status_label)

        env_actions = QHBoxLayout()
        refresh_env = QPushButton("Run Check")
        refresh_env.clicked.connect(self.refresh_environment_status)
        env_actions.addWidget(refresh_env)
        env_actions.addStretch(1)
        env_layout.addLayout(env_actions)

        outer.addWidget(env_frame)

        workspace_frame = QFrame()
        workspace_frame.setFrameShape(QFrame.Shape.StyledPanel)
        workspace_frame.setStyleSheet("QFrame { background: #fcfcfd; border: 1px solid #e5e7eb; border-radius: 12px; }")
        workspace_layout = QVBoxLayout(workspace_frame)
        workspace_layout.setContentsMargins(16, 16, 16, 16)
        workspace_layout.setSpacing(10)

        workspace_header = QHBoxLayout()
        workspace_title = QLabel("Workspace")
        workspace_title.setStyleSheet("font-size: 16px; font-weight: 600;")
        workspace_hint = QLabel("Low-frequency panels")
        workspace_hint.setStyleSheet("color: #5f6b7a;")
        workspace_header.addWidget(workspace_title)
        workspace_header.addStretch(1)
        workspace_header.addWidget(workspace_hint)
        workspace_layout.addLayout(workspace_header)

        workspace_tabs = QTabWidget()
        workspace_tabs.setDocumentMode(True)
        workspace_tabs.setStyleSheet(
            "QTabWidget::pane { border: 1px solid #d7deef; border-radius: 10px; background: white; }"
            "QTabBar::tab { background: #eef2ff; color: #31456a; padding: 8px 14px; margin-right: 4px; border-top-left-radius: 8px; border-top-right-radius: 8px; }"
            "QTabBar::tab:selected { background: #163b72; color: white; }"
        )
        workspace_layout.addWidget(workspace_tabs)

        jobs_tab = QWidget()
        jobs_layout = QVBoxLayout(jobs_tab)
        jobs_layout.setContentsMargins(16, 16, 16, 16)
        jobs_layout.setSpacing(10)

        jobs_header = QHBoxLayout()
        self.jobs_summary_label = QLabel("0 folders")
        self.jobs_summary_label.setStyleSheet("color: #5f6b7a;")
        jobs_header.addStretch(1)
        jobs_header.addWidget(self.jobs_summary_label)
        jobs_layout.addLayout(jobs_header)

        self.jobs_list = QListWidget()
        self.jobs_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        self.jobs_list.itemDoubleClicked.connect(self.open_selected_job)
        self.jobs_list.setMinimumHeight(140)
        self.jobs_list.setStyleSheet("background: white; border: 1px solid #d7deef;")
        jobs_layout.addWidget(self.jobs_list)

        jobs_actions = QHBoxLayout()
        refresh_jobs = QPushButton("Refresh Jobs")
        refresh_jobs.clicked.connect(self.refresh_jobs_list)
        open_job = QPushButton("Open Job Folder")
        open_job.clicked.connect(self.open_selected_job)
        delete_job = QPushButton("Delete Selected")
        delete_job.clicked.connect(self.delete_selected_jobs)
        clear_jobs = QPushButton("Clear All Jobs")
        clear_jobs.clicked.connect(self.clear_all_jobs)
        jobs_actions.addWidget(refresh_jobs)
        jobs_actions.addWidget(open_job)
        jobs_actions.addWidget(delete_job)
        jobs_actions.addWidget(clear_jobs)
        jobs_actions.addStretch(1)
        jobs_layout.addLayout(jobs_actions)

        recent_tab = QWidget()
        recent_layout = QVBoxLayout(recent_tab)
        recent_layout.setContentsMargins(16, 16, 16, 16)
        recent_layout.setSpacing(10)

        recent_header = QHBoxLayout()
        self.recent_summary_label = QLabel("0 files")
        self.recent_summary_label.setStyleSheet("color: #5f6b7a;")
        recent_header.addStretch(1)
        recent_header.addWidget(self.recent_summary_label)
        recent_layout.addLayout(recent_header)

        self.recent_outputs_list = QListWidget()
        self.recent_outputs_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        self.recent_outputs_list.itemDoubleClicked.connect(self.open_selected_recent_output)
        self.recent_outputs_list.setMinimumHeight(140)
        self.recent_outputs_list.setStyleSheet("background: white; border: 1px solid #d7deef;")
        recent_layout.addWidget(self.recent_outputs_list)

        recent_actions = QHBoxLayout()
        refresh_recent = QPushButton("Refresh Outputs")
        refresh_recent.clicked.connect(self.refresh_recent_outputs)
        open_recent_file = QPushButton("Open Output File")
        open_recent_file.clicked.connect(self.open_selected_recent_output)
        open_recent_folder = QPushButton("Open Output Folder")
        open_recent_folder.clicked.connect(self.open_recent_output_folder)
        recent_actions.addWidget(refresh_recent)
        recent_actions.addWidget(open_recent_file)
        recent_actions.addWidget(open_recent_folder)
        recent_actions.addStretch(1)
        recent_layout.addLayout(recent_actions)

        details_tab = QWidget()
        details_layout = QVBoxLayout(details_tab)
        details_layout.setContentsMargins(16, 16, 16, 16)
        details_layout.setSpacing(10)

        details_header = QHBoxLayout()
        self.details_summary_label = QLabel("No item selected")
        self.details_summary_label.setStyleSheet("color: #5f6b7a;")
        details_header.addStretch(1)
        details_header.addWidget(self.details_summary_label)
        details_layout.addLayout(details_header)

        self.details_view = QTextEdit()
        self.details_view.setReadOnly(True)
        self.details_view.setMinimumHeight(120)
        self.details_view.setStyleSheet("background: white; border: 1px solid #d7deef;")
        details_layout.addWidget(self.details_view)

        workspace_tabs.addTab(jobs_tab, "Job Cache")
        workspace_tabs.addTab(recent_tab, "Recent Outputs")
        workspace_tabs.addTab(details_tab, "Task Details")

        outer.addWidget(workspace_frame)

        log_label = QLabel("Runtime Log")
        log_label.setStyleSheet("font-size: 16px; font-weight: 600;")
        outer.addWidget(log_label)

        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setStyleSheet("background: #101317; color: #dde7f7; border-radius: 12px; padding: 8px;")
        outer.addWidget(self.log_view, 1)
        self.refresh_jobs_list()
        self.load_last_state()
        self.restore_queue(show_message=False)
        self.refresh_recent_outputs()
        self.refresh_task_details()
        self.refresh_environment_status()

    def append_log(self, text: str) -> None:
        if not text:
            return
        self.log_view.appendPlainText(text.rstrip())

    def add_paths(self, paths: list[str]) -> None:
        existing = {self.file_list.item(i).data(Qt.ItemDataRole.UserRole) for i in range(self.file_list.count())}
        added_paths: list[Path] = []
        for raw in paths:
            path = Path(raw)
            if path.is_dir():
                for child in sorted(path.iterdir()):
                    if child.is_file():
                        if self._add_one_file(child, existing):
                            added_paths.append(child.resolve())
            else:
                if self._add_one_file(path, existing):
                    added_paths.append(path.resolve())
        self._apply_auto_output_dir(added_paths)
        self.refresh_environment_status()

    def _add_one_file(self, path: Path, existing: set[str]) -> bool:
        ext = path.suffix.lower()
        if ext not in SUPPORTED_EXTS:
            return False
        resolved = str(path.resolve())
        if resolved in existing:
            return False
        existing.add(resolved)
        item = QListWidgetItem(path.name)
        item.setToolTip(resolved)
        item.setData(Qt.ItemDataRole.UserRole, resolved)
        item.setData(Qt.ItemDataRole.UserRole + 1, path.name)
        item.setData(Qt.ItemDataRole.UserRole + 2, "")
        item.setText(f"{path.name}    [{ext.lstrip('.')}]    Ready")
        item.setForeground(self._status_color("Ready"))
        self.file_list.addItem(item)
        self._persist_queue_state()
        self._update_retry_button()
        return True

    def select_files(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(
            self,
            "Select Media Files",
            str(Path.home()),
            "Media Files (*.m4a *.mp3 *.wav *.aac *.flac *.ogg *.wma *.m4b *.mp4 *.mov *.mkv *.avi *.wmv *.flv *.webm *.m4v)",
        )
        if files:
            self.add_paths(files)

    def select_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Select Folder", str(Path.home()))
        if folder:
            self.add_paths([folder])

    def clear_files(self, *, persist: bool = True) -> None:
        if self._is_processing():
            return
        self.file_list.clear()
        self.latest_results.clear()
        self.completed_count = 0
        self.failed_count = 0
        self.total_count = 0
        self.progress_bar.setRange(0, 1)
        self.progress_bar.setValue(0)
        self.progress_bar.setFormat("0 / 0")
        self.summary_label.setText("Ready")
        self.current_stage_label.setText("No active task")
        self.open_file_button.setEnabled(False)
        self.retry_button.setEnabled(False)
        self.select_failed_button.setEnabled(False)
        self.output_dir_manually_set = False
        self.last_auto_output_dir = str(DEFAULT_OUTPUT_DIR)
        self.output_edit.setText(str(DEFAULT_OUTPUT_DIR))
        if persist:
            self._persist_queue_state()
        self.refresh_task_details()
        self.refresh_recent_outputs()
        if persist:
            self._persist_current_state()

    def remove_selected(self) -> None:
        if self._is_processing():
            return
        for item in self.file_list.selectedItems():
            self.file_list.takeItem(self.file_list.row(item))
        self._persist_queue_state()
        self._update_retry_button()
        self.refresh_task_details()
        self.refresh_environment_status()

    def choose_output_dir(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Select Output Folder", self.output_edit.text())
        if folder:
            self.output_edit.setText(folder)
            self.output_dir_manually_set = True
            self._persist_current_state()
            self.refresh_recent_outputs()
            self.refresh_environment_status()

    def _handle_output_edit_finished(self) -> None:
        value = self.output_edit.text().strip()
        self.output_dir_manually_set = bool(value) and value != self.last_auto_output_dir
        self._persist_current_state()

    def _apply_auto_output_dir(self, paths: list[Path]) -> None:
        if not paths or self.output_dir_manually_set:
            return
        target_dir = str(paths[0].parent)
        self.last_auto_output_dir = target_dir
        self.output_edit.setText(target_dir)
        self._persist_current_state()
        self.refresh_recent_outputs()

    def show_file_context_menu(self, pos) -> None:
        item = self.file_list.itemAt(pos)
        if item is None:
            return
        menu = QMenu(self)
        retry_action = menu.addAction("Retry Selected")
        open_result_action = menu.addAction("Open Result File")
        chosen = menu.exec(self.file_list.mapToGlobal(pos))
        if chosen == retry_action:
            self.retry_selected()
        elif chosen == open_result_action:
            self.open_selected_result()

    def start_processing(self) -> None:
        self.start_processing_for_paths(
            [self.file_list.item(i).data(Qt.ItemDataRole.UserRole) for i in range(self.file_list.count())]
        )

    def start_processing_for_paths(self, paths: list[str]) -> None:
        if self.worker_thread and self.worker_thread.isRunning():
            QMessageBox.information(self, "Busy", "A processing task is already running.")
            return
        if not paths:
            QMessageBox.warning(self, "No Files", "Add at least one media file first.")
            return
        env_errors = self.environment_errors_for_paths(paths)
        if env_errors:
            QMessageBox.warning(self, "Environment Check Failed", "\n".join(env_errors))
            self.refresh_environment_status()
            return
        output_dir = self.output_edit.text().strip()
        if output_dir:
            Path(output_dir).mkdir(parents=True, exist_ok=True)

        self.log_view.clear()
        self.append_log("Starting process via core.media_pipeline")
        self.latest_results.clear()
        self.completed_count = 0
        self.failed_count = 0
        self.open_file_button.setEnabled(False)
        self.open_output_button.setEnabled(False)
        self.retry_button.setEnabled(False)
        self._set_processing_ui_state(True)
        self.total_count = len(paths)
        self.progress_bar.setRange(0, max(1, self.total_count))
        self.progress_bar.setValue(0)
        self.progress_bar.setFormat(f"0 / {self.total_count}")
        self.summary_label.setText(f"Queued 0 / {self.total_count}")
        self.current_stage_label.setText("Waiting to start")
        self._set_selected_status(paths, "Queued")
        self.worker_thread = QThread(self)
        self.worker = PipelineWorker(
            paths=paths,
            output_format=self.format_combo.currentText(),
            translate=self.translate_checkbox.isChecked(),
            output_dir=output_dir,
        )
        self.worker.moveToThread(self.worker_thread)
        self.worker_thread.started.connect(self.worker.run)
        self.worker.log_emitted.connect(self.append_log)
        self.worker.file_started.connect(self.mark_file_running)
        self.worker.stage_changed.connect(self.mark_file_stage)
        self.worker.file_finished.connect(self.mark_file_finished)
        self.worker.results_ready.connect(self.store_results)
        self.worker.all_finished.connect(self.process_finished)
        self.worker.all_finished.connect(self.worker_thread.quit)
        self.worker_thread.finished.connect(self.worker.deleteLater)
        self.worker_thread.finished.connect(self.worker_thread.deleteLater)
        self.run_button.setEnabled(False)
        self.worker_thread.start()

    def process_finished(self, exit_code: int, message: str) -> None:
        self._set_processing_ui_state(False)
        self.run_button.setEnabled(True)
        self.worker = None
        self.worker_thread = None
        self.refresh_jobs_list()
        self.refresh_recent_outputs()
        if exit_code == 0:
            self.append_log("\nCompleted successfully.")
            self.open_output_button.setEnabled(True)
            self.open_file_button.setEnabled(bool(self.latest_results))
            self.current_stage_label.setText("All tasks finished")
            self.retry_button.setEnabled(True)
            self.select_failed_button.setEnabled(self._has_failed_items())
            QMessageBox.information(self, "Done", message)
        else:
            self.append_log(f"\nProcess failed with exit code {exit_code}.")
            self.open_output_button.setEnabled(bool(self.output_edit.text().strip()))
            self.open_file_button.setEnabled(bool(self.latest_results))
            self.current_stage_label.setText("Completed with failures")
            self.retry_button.setEnabled(True)
            self.select_failed_button.setEnabled(self._has_failed_items())
            QMessageBox.warning(self, "Failed", message)
        self._persist_queue_state()
        self._refresh_summary()

    def _set_all_status(self, status: str) -> None:
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            name = item.data(Qt.ItemDataRole.UserRole + 1)
            suffix = Path(item.data(Qt.ItemDataRole.UserRole)).suffix.lower().lstrip(".")
            item.setText(f"{name}    [{suffix}]    {status}")

    def _set_selected_status(self, paths: list[str], status: str) -> None:
        path_set = set(paths)
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            stored = item.data(Qt.ItemDataRole.UserRole)
            if stored in path_set:
                name = item.data(Qt.ItemDataRole.UserRole + 1)
                suffix = Path(stored).suffix.lower().lstrip(".")
                item.setText(f"{name}    [{suffix}]    {status}")
                item.setForeground(self._status_color(status))

    def mark_file_running(self, source_path: str) -> None:
        self._set_item_status(source_path, "Running")
        self.current_stage_label.setText(f"Current: {Path(source_path).name}")

    def mark_file_stage(self, source_path: str, detail: str) -> None:
        self._set_item_status(source_path, detail)
        self.current_stage_label.setText(f"{Path(source_path).name}  |  {detail}")

    def mark_file_finished(self, source_path: str, status: str) -> None:
        self._set_item_status(source_path, status)
        if status.startswith("Done:"):
            self.completed_count += 1
        elif status.startswith("Failed:"):
            self.failed_count += 1
        self.progress_bar.setValue(min(self.completed_count + self.failed_count, max(1, self.total_count)))
        self.progress_bar.setFormat(f"{self.completed_count + self.failed_count} / {self.total_count}")
        self._refresh_summary()

    def store_results(self, pairs: list) -> None:
        for source_path, output_path in pairs:
            self.latest_results[source_path] = output_path
        if pairs:
            last_source, _last_output = pairs[-1]
            self._select_source_item(last_source)
            self.open_file_button.setEnabled(True)
            self.refresh_task_details()

    def _set_item_status(self, source_path: str, status: str) -> None:
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            stored = item.data(Qt.ItemDataRole.UserRole)
            if stored == source_path:
                name = item.data(Qt.ItemDataRole.UserRole + 1)
                suffix = Path(stored).suffix.lower().lstrip(".")
                item.setData(Qt.ItemDataRole.UserRole + 2, status)
                item.setText(f"{name}    [{suffix}]    {status}")
                item.setForeground(self._status_color(status))
                break
        self._persist_queue_state()

    def _status_color(self, status: str) -> QColor:
        lower = status.lower()
        if lower.startswith("done:"):
            return QColor("#1f7a3d")
        if lower.startswith("failed:"):
            return QColor("#b42318")
        if "running" in lower or "upload" in lower or "transcrib" in lower or "translat" in lower:
            return QColor("#1d4ed8")
        if "queued" in lower or "waiting" in lower or "prepar" in lower or "cleaning" in lower or "writing" in lower:
            return QColor("#7c5c00")
        return QColor("#1f2937")

    def _refresh_summary(self) -> None:
        if self.total_count == 0:
            self.summary_label.setText("Ready")
            return
        pending = max(self.total_count - self.completed_count - self.failed_count, 0)
        self.summary_label.setText(
            f"Done {self.completed_count}  |  Failed {self.failed_count}  |  Pending {pending}"
        )

    def _select_source_item(self, source_path: str) -> None:
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            if item.data(Qt.ItemDataRole.UserRole) == source_path:
                self.file_list.setCurrentItem(item)
                self.file_list.scrollToItem(item)
                break

    def refresh_task_details(self) -> None:
        item = self.file_list.currentItem()
        if item is None:
            self.details_summary_label.setText("No item selected")
            self.details_view.setPlainText("Select a queue item to inspect its current state.")
            return
        source_path = str(item.data(Qt.ItemDataRole.UserRole) or "")
        name = str(item.data(Qt.ItemDataRole.UserRole + 1) or Path(source_path).name)
        status = str(item.data(Qt.ItemDataRole.UserRole + 2) or "Ready")
        result_path = self.latest_results.get(source_path, "")
        detail_lines = [
            f"Name: {name}",
            f"Source: {source_path}",
            f"Status: {status}",
            f"Output Format: {self.format_combo.currentText()}",
            f"Translate: {'Yes' if self.translate_checkbox.isChecked() else 'No'}",
            f"Output Folder: {self.output_edit.text().strip() or DEFAULT_OUTPUT_DIR}",
            f"Result File: {result_path or 'Not available yet'}",
        ]
        self.details_summary_label.setText(status)
        self.details_view.setPlainText("\n".join(detail_lines))

    def _update_retry_button(self) -> None:
        has_selection = bool(self.file_list.selectedItems() or self.file_list.currentItem())
        self.retry_button.setEnabled(
            self.file_list.count() > 0
            and has_selection
            and not self._is_processing()
        )
        self.select_failed_button.setEnabled(self._has_failed_items() and not self._is_processing())

    def _is_processing(self) -> bool:
        return bool(self.worker_thread and self.worker_thread.isRunning())

    def _set_processing_ui_state(self, processing: bool) -> None:
        self.add_files_action.setEnabled(not processing)
        self.add_folder_action.setEnabled(not processing)
        self.clear_action.setEnabled(not processing)
        self.remove_selected_button.setEnabled(not processing)
        self.select_failed_button.setEnabled(self._has_failed_items() and not processing)
        self.file_list.setDragEnabled(not processing)
        self.file_list.setAcceptDrops(not processing)
        self.file_list.setSelectionMode(
            QListWidget.SelectionMode.ExtendedSelection if not processing else QListWidget.SelectionMode.SingleSelection
        )

    def retry_selected(self) -> None:
        selected = self.file_list.selectedItems()
        if not selected:
            item = self.file_list.currentItem()
            if item is not None:
                selected = [item]
        if not selected:
            QMessageBox.information(self, "No Selection", "Select one or more files to retry.")
            return
        paths = [item.data(Qt.ItemDataRole.UserRole) for item in selected]
        self.start_processing_for_paths(paths)

    def select_failed_items(self) -> None:
        if self._is_processing():
            return
        self.file_list.clearSelection()
        found = False
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            status = str(item.data(Qt.ItemDataRole.UserRole + 2) or "")
            if status.startswith("Failed:"):
                item.setSelected(True)
                if not found:
                    self.file_list.setCurrentItem(item)
                    found = True
        if not found:
            QMessageBox.information(self, "No Failed Items", "There are no failed items in the queue.")

    def _has_failed_items(self) -> bool:
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            status = str(item.data(Qt.ItemDataRole.UserRole + 2) or "")
            if status.startswith("Failed:"):
                return True
        return False

    def _queue_payload(self) -> list[dict[str, str]]:
        payload: list[dict[str, str]] = []
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            payload.append(
                {
                    "path": str(item.data(Qt.ItemDataRole.UserRole) or ""),
                    "name": str(item.data(Qt.ItemDataRole.UserRole + 1) or ""),
                    "status": str(item.data(Qt.ItemDataRole.UserRole + 2) or ""),
                }
            )
        return payload

    def _persist_queue_state(self) -> None:
        if not self.queue_persistence_enabled:
            return
        QUEUE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        QUEUE_STATE_PATH.write_text(json.dumps(self._queue_payload(), ensure_ascii=False, indent=2), encoding="utf-8")

    def restore_queue(self, show_message: bool = True) -> None:
        if self._is_processing():
            return
        if not QUEUE_STATE_PATH.exists():
            if show_message:
                QMessageBox.information(self, "No Queue", f"No queue file found:\n{QUEUE_STATE_PATH}")
            return
        data = json.loads(QUEUE_STATE_PATH.read_text(encoding="utf-8"))
        self.queue_persistence_enabled = False
        try:
            self.file_list.clear()
            existing: set[str] = set()
            restored = 0
            for entry in data:
                raw_path = Path(str(entry.get("path", "")))
                if not raw_path.exists() or raw_path.suffix.lower() not in SUPPORTED_EXTS:
                    continue
                self._add_one_file(raw_path, existing)
                item = self.file_list.item(self.file_list.count() - 1)
                status = str(entry.get("status", "")) or "Ready"
                item.setData(Qt.ItemDataRole.UserRole + 2, status)
                suffix = raw_path.suffix.lower().lstrip(".")
                item.setText(f"{raw_path.name}    [{suffix}]    {status}")
                item.setForeground(self._status_color(status))
                restored += 1
        finally:
            self.queue_persistence_enabled = True
        self._update_retry_button()
        if show_message:
            QMessageBox.information(self, "Queue Restored", f"Restored {restored} queue item(s) from:\n{QUEUE_STATE_PATH}")

    def _current_preset_payload(self) -> dict[str, object]:
        return {
            "output_format": self.format_combo.currentText(),
            "translate": self.translate_checkbox.isChecked(),
            "output_dir": self.output_edit.text().strip() or str(DEFAULT_OUTPUT_DIR),
        }

    def _write_settings_file(self, target: Path) -> None:
        if not self.preset_autosave_enabled:
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(self._current_preset_payload(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _persist_current_state(self, *_args) -> None:
        self._write_settings_file(GUI_STATE_PATH)
        self.refresh_environment_status()

    def save_preset(self) -> None:
        self._write_settings_file(GUI_PRESET_PATH)
        QMessageBox.information(self, "Preset Saved", f"Preset saved to:\n{GUI_PRESET_PATH}")

    def export_log(self) -> None:
        default_target = str(DEFAULT_LOG_EXPORT_PATH)
        path, _ = QFileDialog.getSaveFileName(self, "Export Runtime Log", default_target, "Text Files (*.txt)")
        if not path:
            return
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(self.log_view.toPlainText(), encoding="utf-8")
        QMessageBox.information(self, "Log Exported", f"Runtime log exported to:\n{target}")

    def cleanup_cache(self) -> None:
        if self._is_processing():
            QMessageBox.information(self, "Busy", "Wait for the current processing task to finish before cleaning cache.")
            return

        targets = [JOBS_ROOT, QUEUE_STATE_PATH, GUI_STATE_PATH, DEFAULT_LOG_EXPORT_PATH]
        existing_targets = [path for path in targets if path.exists()]
        if not existing_targets and not self.log_view.toPlainText().strip():
            QMessageBox.information(self, "Nothing To Clean", "No cache files or temporary job folders were found.")
            return

        reply = QMessageBox.question(
            self,
            "Cleanup Cache",
            "Delete all intermediate cache data?\n\n"
            "This removes job folders, extracted audio, transcript cache, queue state, and runtime logs.\n"
            "Final txt/srt outputs and saved presets will be kept.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        removed_items = 0
        for path in existing_targets:
            if path.is_dir():
                shutil.rmtree(path)
                removed_items += 1
            elif path.is_file():
                path.unlink()
                removed_items += 1

        self.clear_files(persist=False)
        self.log_view.clear()
        self.refresh_jobs_list()
        self.refresh_recent_outputs()
        self.refresh_task_details()
        self.refresh_environment_status()
        QMessageBox.information(self, "Cleanup Complete", f"Removed {removed_items} cache item(s).")

    def show_about_dialog(self) -> None:
        QMessageBox.information(
            self,
            f"About {APP_NAME}",
            f"{APP_NAME} {APP_VERSION}\n{APP_DESCRIPTION}\n\nThis release bundles ffmpeg/ffprobe in the packaged build.",
        )

    def _apply_settings_file(self, source: Path, show_missing_message: bool) -> bool:
        if not source.exists():
            if show_missing_message:
                QMessageBox.information(self, "No Preset", f"No preset file found:\n{source}")
            return False
        data = json.loads(source.read_text(encoding="utf-8"))
        output_format = str(data.get("output_format", "txt"))
        translate = bool(data.get("translate", True))
        output_dir = str(data.get("output_dir", DEFAULT_OUTPUT_DIR))
        self.preset_autosave_enabled = False
        try:
            if output_format in {"txt", "srt"}:
                self.format_combo.setCurrentText(output_format)
            self.translate_checkbox.setChecked(translate)
            self.output_edit.setText(output_dir)
            self.last_auto_output_dir = output_dir
            self.output_dir_manually_set = output_dir != str(DEFAULT_OUTPUT_DIR)
        finally:
            self.preset_autosave_enabled = True
        return True

    def load_last_state(self) -> None:
        self._apply_settings_file(GUI_STATE_PATH, show_missing_message=False)

    def load_preset(self, show_message: bool = True) -> None:
        loaded = self._apply_settings_file(GUI_PRESET_PATH, show_missing_message=show_message)
        if not loaded:
            return
        self.refresh_recent_outputs()
        self.refresh_environment_status()
        if show_message:
            QMessageBox.information(self, "Preset Loaded", f"Preset loaded from:\n{GUI_PRESET_PATH}")

    def _queued_paths(self) -> list[Path]:
        paths: list[Path] = []
        for i in range(self.file_list.count()):
            raw = self.file_list.item(i).data(Qt.ItemDataRole.UserRole)
            if raw:
                paths.append(Path(str(raw)))
        return paths

    def _compute_environment_checks(self, paths: list[Path] | None = None):
        queue_paths = paths if paths is not None else self._queued_paths()
        needs_video_tools = any(path.suffix.lower() in VIDEO_EXTS for path in queue_paths)
        needs_translation = self.translate_checkbox.isChecked()
        return collect_environment_checks(
            needs_translation=needs_translation,
            needs_video_tools=needs_video_tools,
        )

    def refresh_environment_status(self) -> None:
        checks = self._compute_environment_checks()
        self.last_environment_checks = checks
        bad = [check for check in checks if not check.ok]
        if bad:
            self.env_summary_label.setText(f"{len(bad)} issue(s)")
            self.env_summary_label.setStyleSheet("color: #b42318; font-weight: 600;")
        else:
            self.env_summary_label.setText("Ready")
            self.env_summary_label.setStyleSheet("color: #1f7a3d; font-weight: 600;")
        lines = []
        for check in checks:
            prefix = "OK" if check.ok else "Missing"
            lines.append(f"{prefix} {check.name}: {check.detail}")
        self.env_status_label.setText("\n".join(lines))

    def environment_errors_for_paths(self, paths: list[str]) -> list[str]:
        checks = self._compute_environment_checks([Path(p) for p in paths])
        errors: list[str] = []
        for check in checks:
            if not check.ok:
                if check.name in {"ffmpeg", "ffprobe"}:
                    errors.append("Video extraction requires ffmpeg/ffprobe. Install them or place them under D:\\program\\ffmpeg\\bin\\")
                elif check.name == "gladia":
                    errors.append(
                        f"Gladia key is missing. Set GLADIA_API_KEY or create {APP_RUNTIME_ROOT / 'config' / 'gladia_keys.txt'}."
                    )
                elif check.name == "deepl":
                    errors.append(
                        "DeepL key is missing. "
                        f"Set DEEPL_KEY or create {APP_RUNTIME_ROOT / 'config' / 'deepl_key.txt'}, or turn translation off."
                    )
                else:
                    errors.append(f"{check.name}: {check.detail}")
        return list(dict.fromkeys(errors))

    def refresh_recent_outputs(self) -> None:
        self.recent_outputs_list.clear()
        output_root = Path(self.output_edit.text().strip() or DEFAULT_OUTPUT_DIR)
        if not output_root.exists():
            self.recent_summary_label.setText("0 files")
            return
        recent_files = sorted(
            (
                path
                for path in output_root.iterdir()
                if path.is_file() and path.suffix.lower() in {".txt", ".srt"}
            ),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:30]
        for output_path in recent_files:
            stat = output_path.stat()
            item = QListWidgetItem(f"{output_path.name}    [{self._format_mtime(stat.st_mtime)}]")
            item.setToolTip(str(output_path))
            item.setData(Qt.ItemDataRole.UserRole, str(output_path))
            self.recent_outputs_list.addItem(item)
        self.recent_summary_label.setText(f"{len(recent_files)} files")

    def open_selected_recent_output(self) -> None:
        item = self.recent_outputs_list.currentItem()
        if not item:
            QMessageBox.information(self, "No Selection", "Select an output file first.")
            return
        path = Path(item.data(Qt.ItemDataRole.UserRole))
        if path.exists():
            os.startfile(path)

    def open_recent_output_folder(self) -> None:
        item = self.recent_outputs_list.currentItem()
        if not item:
            folder = Path(self.output_edit.text().strip() or DEFAULT_OUTPUT_DIR)
        else:
            folder = Path(item.data(Qt.ItemDataRole.UserRole)).parent
        if folder.exists():
            os.startfile(folder)

    def refresh_jobs_list(self) -> None:
        self.jobs_list.clear()
        JOBS_ROOT.mkdir(parents=True, exist_ok=True)
        job_dirs = sorted((path for path in JOBS_ROOT.iterdir() if path.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
        for job_dir in job_dirs:
            stat = job_dir.stat()
            item = QListWidgetItem(f"{job_dir.name}    [{self._format_mtime(stat.st_mtime)}]")
            item.setToolTip(str(job_dir))
            item.setData(Qt.ItemDataRole.UserRole, str(job_dir))
            self.jobs_list.addItem(item)
        self.jobs_summary_label.setText(f"{len(job_dirs)} folders")

    def _format_mtime(self, ts: float) -> str:
        from datetime import datetime

        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")

    def open_selected_job(self) -> None:
        item = self.jobs_list.currentItem()
        if not item:
            QMessageBox.information(self, "No Selection", "Select a job folder first.")
            return
        path = Path(item.data(Qt.ItemDataRole.UserRole))
        if path.exists():
            os.startfile(path)

    def delete_selected_jobs(self) -> None:
        items = self.jobs_list.selectedItems()
        if not items:
            QMessageBox.information(self, "No Selection", "Select one or more job folders first.")
            return
        names = ", ".join(Path(item.data(Qt.ItemDataRole.UserRole)).name for item in items[:3])
        if len(items) > 3:
            names += " ..."
        reply = QMessageBox.question(
            self,
            "Delete Job Folders",
            f"Delete {len(items)} job folder(s)?\n{names}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        for item in items:
            path = Path(item.data(Qt.ItemDataRole.UserRole))
            if path.exists():
                shutil.rmtree(path)
        self.refresh_jobs_list()

    def clear_all_jobs(self) -> None:
        JOBS_ROOT.mkdir(parents=True, exist_ok=True)
        items = [path for path in JOBS_ROOT.iterdir() if path.is_dir()]
        if not items:
            QMessageBox.information(self, "No Jobs", "There are no job folders to delete.")
            return
        reply = QMessageBox.question(
            self,
            "Clear All Jobs",
            f"Delete all {len(items)} job folder(s) under {JOBS_ROOT}?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        for path in items:
            shutil.rmtree(path)
        self.refresh_jobs_list()

    def open_output_folder(self) -> None:
        folder = self.output_edit.text().strip()
        if not folder:
            return
        path = Path(folder)
        if path.exists():
            os.startfile(path)

    def open_selected_result(self) -> None:
        item = self.file_list.currentItem()
        if not item:
            QMessageBox.information(self, "No Selection", "Select one processed file first.")
            return
        source_path = item.data(Qt.ItemDataRole.UserRole)
        result = self.latest_results.get(source_path)
        if not result:
            QMessageBox.information(self, "No Result", "The selected file does not have a finished result yet.")
            return
        output_path = Path(result)
        if output_path.exists():
            os.startfile(output_path)


def main() -> int:
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
