export const COPY = {
  'zh-Hant': {
    title: '粵語影片，英文字幕。', brand: '粵語字幕', back: '返回語音轉字幕', intro: '上傳原影片，自動轉寫、核對術語及畫面，產生英文字幕。',
    upload: '拖入原影片', choose: '或按一下選擇檔案', limits: 'MP4、MOV、MKV、WebM · 不設影片時長或檔案大小上限', start: '產生英文字幕',
    glossary: '專有名稱或固定譯法（選填）', glossaryHint: '例如：公司名稱、指數代碼，以及你希望沿用的英文譯法', optional: '補充術語',
    history: '最近的影片', pickHistory: '開啟先前的工作', flow1: '擷取音軌', flow2: '粵語轉寫', flow3: '詞庫與畫面核對', flow4: '英文翻譯與複核',
    ready: '可以開始', unconfigured: '服務尚未配置', checking: '正在檢查服務…', service: 'MiniMax ASR + M3',
    mediaUnavailable: '媒體處理工具尚未就緒，請聯絡管理員。',
    requestTimeout: '模型回應逾時，已保留進度。請先核對服務商記錄，再決定是否重送。',
    privacy: '影片上傳至此服務處理；音軌和必要截圖會傳送至 MiniMax。',
    draftNote: '自動產生的字幕仍需核對。畫面不清楚或口述含糊的地方會保留提示。',
    sourceTitle: '這幾處需要你確認', sourceIntro: '請回聽並核對畫面。只修改有依據的文字；確認後會自動接續英文翻譯。',
    sourceConfirm: '已核對以上疑點，繼續翻譯', reviewedLabel: '我已回聽並確認以上疑點', source: '粵語文稿', english: '英文字幕',
    suggestion: '建議', evidence: '查看核對依據與截圖', note: '保留已知易錯詞時，請說明依據', seek: '播放此段',
    resultTitle: '英文字幕已完成', resultIntro: '預覽、修改或直接下載 SRT，再與原影片一起上傳至 YouTube。', download: '下載英文 SRT',
    save: '儲存修改', saved: '修改已儲存', all: '全部字幕', questions: '只看待確認', noQuestions: '沒有自動檢查提示；仍建議抽查原音與譯文。',
    count: '條字幕', pending: '條待確認', preview: '字幕預覽', sourceDetails: '粵語與修正記錄', newVideo: '處理另一部影片',
    resume: '繼續處理', paused: '工作已暫停，已完成的步驟會保留。', unknown: '上次請求結果未知；我已核對服務商記錄，允許重發（可能再次計費）',
    uploading: '正在上傳影片', preflight: '正在檢查服務', queued: '準備處理', extracting: '正在擷取音軌', recognizing: '正在轉寫粵語',
    transcribing: '正在轉寫粵語', 'reading-frames': '正在讀取畫面文字', 'source-checking': '正在核對粵語與截圖', 'source-review': '等待確認粵語疑點', translating: '正在翻譯英文', 'english-checking': '正在複核英文', done: '處理完成',
    error: '處理暫停', capacity: '模型目前忙碌，請在倒數結束後繼續。', cooldown: '秒後可繼續',
    invalidFile: '請選擇非空的 MP4、MOV、MKV 或 WebM 影片。', unsaved: '請先儲存目前的修改。', networkError: '連線中斷，請稍後重試；已建立的工作可從最近影片重新開啟。',
    genericError: '操作未完成，請查看詳細訊息後重試。', details: '詳細訊息', sourceChanged: '內容已有更新，請重新開啟這個工作後再操作。',
    sourceUnclear: '請先解決缺詞，並為保留的已知易錯詞填寫說明。', busy: '另一個工作正在處理，請稍後再試。', keyError: '服務的金鑰、權限或額度需要檢查。',
    warningLayout: '字幕較長，可調整文字後再下載。', warningSpeed: '閱讀速度偏快，請留意預覽效果。', warningSemantic: '這一段的意思或術語需要再核對。',
    warningStale: '英文編輯後尚未重新經模型複核，請核對修改。', pendingLabel: '待核對', progressLabel: '處理進度', filename: '已選影片', empty: '尚未選擇影片',
  },
  en: {
    title: 'Cantonese video. English subtitles.', brand: 'Cantonese subtitles', back: 'Back to speech-to-text', intro: 'Upload your original video. We transcribe Cantonese, check terms against video frames, and create English subtitles.',
    upload: 'Drop your original video', choose: 'or click to choose a file', limits: 'MP4, MOV, MKV, WebM · No video duration or file size limit', start: 'Create English subtitles',
    glossary: 'Names or preferred translations (optional)', glossaryHint: 'Company names, index tickers, or English terms you want to keep', optional: 'Add terminology',
    history: 'Recent videos', pickHistory: 'Open an earlier job', flow1: 'Extract audio', flow2: 'Transcribe Cantonese', flow3: 'Check terms and frames', flow4: 'Translate and review English',
    ready: 'Ready to start', unconfigured: 'Service not configured', checking: 'Checking service…', service: 'MiniMax ASR + M3',
    mediaUnavailable: 'Media processing tools are not ready. Please contact the administrator.',
    requestTimeout: 'The model response timed out. Progress is saved. Check the provider records before choosing to resend.',
    privacy: 'Your video is uploaded to this service. Its audio and selected frames are sent to MiniMax.',
    draftNote: 'Automatic subtitles need review. Unclear speech and visual evidence will be flagged.',
    sourceTitle: 'A few source details need your review', sourceIntro: 'Listen and check the frames. Make evidence-based edits, then continue to English translation.',
    sourceConfirm: 'Confirm these items and translate', reviewedLabel: 'I have listened and checked the items above', source: 'Cantonese transcript', english: 'English subtitles',
    suggestion: 'Suggestion', evidence: 'Review notes and video frames', note: 'Explain the evidence if keeping a known error spelling', seek: 'Play this segment',
    resultTitle: 'Your English subtitles are ready', resultIntro: 'Preview, edit, or download the SRT, then upload it to YouTube alongside the original video.', download: 'Download English SRT',
    save: 'Save edits', saved: 'Edits saved', all: 'All subtitles', questions: 'Review items only', noQuestions: 'No automatic flags. We still recommend spot-checking the audio and translation.',
    count: 'subtitles', pending: 'to review', preview: 'Subtitle preview', sourceDetails: 'Cantonese and correction history', newVideo: 'Process another video',
    resume: 'Continue processing', paused: 'This job is paused. Completed steps are saved.', unknown: 'The previous request has an unknown outcome. I checked the provider records and allow resending it (may incur another charge).',
    uploading: 'Uploading video', preflight: 'Checking service', queued: 'Getting ready', extracting: 'Extracting audio', recognizing: 'Transcribing Cantonese',
    transcribing: 'Transcribing Cantonese', 'reading-frames': 'Reading video frames', 'source-checking': 'Checking Cantonese and frames', 'source-review': 'Waiting for source review', translating: 'Translating English', 'english-checking': 'Reviewing English', done: 'Complete',
    error: 'Processing paused', capacity: 'The model is busy. Continue when the countdown ends.', cooldown: 'seconds until you can continue',
    invalidFile: 'Choose a non-empty MP4, MOV, MKV or WebM video.', unsaved: 'Save your current edits first.', networkError: 'Connection interrupted. Try again later. Existing jobs remain available under Recent videos.',
    genericError: 'The action did not complete. Check the details before trying again.', details: 'Details', sourceChanged: 'The content has changed. Reopen this job before continuing.',
    sourceUnclear: 'Resolve missing words and explain any known error spelling you retain.', busy: 'Another job is running. Please try again later.', keyError: 'Check the service credentials, permissions, or available quota.',
    warningLayout: 'This subtitle is long. Consider editing it before download.', warningSpeed: 'Reading speed is high. Check the preview.', warningSemantic: 'Check this segment’s meaning or terminology.',
    warningStale: 'Your English edit has not been checked again by the model. Please review it.', pendingLabel: 'Review needed', progressLabel: 'Processing progress', filename: 'Selected video', empty: 'No video selected',
  },
};

export function message(locale, key) { return (COPY[locale] || COPY['zh-Hant'])[key] || key; }
export function serviceStateKey(config) {
  if (!config) return 'checking';
  if (config.mediaTools === false) return 'mediaUnavailable';
  return config.configured ? 'ready' : 'unconfigured';
}
export function errorKey(error) {
  const text = String(error?.message || error);
  if (/TimeoutError/iu.test(text)) return 'requestTimeout';
  if (/capacity|cooldown|rate.limit|容量|限流|繁忙|稍后|稍後/iu.test(text) || error?.retryAt) return 'capacity';
  if (/changed|revision|已有更新|版本/iu.test(text)) return 'sourceChanged';
  if (/missing source|known error|缺词|易错词/iu.test(text)) return 'sourceUnclear';
  if (/running|正在运行|正在處理|正在处理/iu.test(text)) return 'busy';
  if (/key|quota|balance|authentication|配置|余额|额度|权限/iu.test(text)) return 'keyError';
  if (/fetch|network|connection/iu.test(text)) return 'networkError';
  return 'genericError';
}
