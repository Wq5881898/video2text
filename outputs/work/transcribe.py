from faster_whisper import WhisperModel
import json, sys

src = "/sessions/zealous-upbeat-ritchie/mnt/uploads/Naked_News-2025.08.14_audio.m4a"
model = WhisperModel("small", compute_type="int8")
segments, info = model.transcribe(
    src,
    beam_size=5,
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 500},
    word_timestamps=True,
    language="en",
)

out = []
for s in segments:
    out.append({
        "start": round(s.start, 2),
        "end": round(s.end, 2),
        "text": s.text.strip(),
    })

with open("/sessions/zealous-upbeat-ritchie/mnt/outputs/work/segments.json","w") as f:
    json.dump({"language": info.language, "duration": info.duration, "segments": out}, f, ensure_ascii=False, indent=2)

print("language:", info.language, "duration:", info.duration, "segments:", len(out))
