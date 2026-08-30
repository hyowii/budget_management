"""
Korean Morphological Highlight Service
=======================================
Nhận (term, sentence) → trả về đoạn văn bản CHÍNH XÁC trong câu tương ứng với
từ điển đã cho, kể cả khi từ đó bị chia đuôi (필요하다 → 필요한) hoặc chia bất
quy tắc (듣다 → 들어요, 덥다 → 더워요).

Dùng thư viện Kiwi (kiwipiepy) — bộ phân tích hình thái tiếng Hàn mã nguồn mở,
không cần Java/JVM, tốc độ nhanh, license LGPL/MIT-friendly cho dùng thương mại
lẫn cá nhân.

Cách hoạt động:
1. Phân tích riêng "term" (dạng từ điển, vd "필요하다") để lấy chuỗi hình vị GỐC
   (bỏ đuôi "다" kết thúc câu) — vd "필요하다" → [(필요, NNG), (하, XSA)].
2. Phân tích cả câu ví dụ, dò xem chuỗi hình vị gốc đó có xuất hiện liên tiếp ở
   đâu trong câu không (Kiwi tự khôi phục đúng hình vị gốc kể cả biến âm bất
   quy tắc, nên khớp được cả 듣다→들어, 덥다→더워요).
3. Nếu khớp, mở rộng ra trọn "eojeol" (từ cách nhau bởi khoảng trắng) chứa vị
   trí đó, cắt bỏ dấu câu ở cuối, trả về làm đoạn cần bôi màu.

Chạy thử cục bộ:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Gọi thử:
    curl -X POST http://localhost:8000/highlight \
      -H "Content-Type: application/json" \
      -d '{"term":"필요하다","sentence":"호텔에 계시면서 필요한 것이 있으면 바로 전화 주세요."}'
"""
import re
from typing import List, Optional, Tuple

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from kiwipiepy import Kiwi

app = FastAPI(title="Korean Morphological Highlight Service")

# CHỈNH LẠI: thay "*" bằng domain thật của web app khi deploy thật (vd
# "https://ten-app-cua-ban.vercel.app") để tránh site khác gọi ké API của bạn.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)

kiwi = Kiwi()

TRAILING_PUNCT = '.,!?。？！、·…"\'\u201c\u201d\u2018\u2019)]}'


class HighlightRequest(BaseModel):
    term: str
    sentence: str


class HighlightResponse(BaseModel):
    highlight: Optional[str] = None
    start: Optional[int] = None
    end: Optional[int] = None


def eojeol_spans(sentence: str) -> List[Tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r"\S+", sentence)]


def lemma_sequence(term: str):
    """Phân tích riêng dạng từ điển để lấy chuỗi hình vị gốc, bỏ đuôi "다" kết thúc câu."""
    results = kiwi.analyze(term)
    if not results:
        return []
    tokens, _ = results[0]
    return [(t.form, t.tag) for t in tokens if not (t.tag == "EF" and t.form == "다")]


@app.post("/highlight", response_model=HighlightResponse)
def highlight(req: HighlightRequest):
    term = (req.term or "").strip()
    sentence = req.sentence or ""
    if not term or not sentence:
        return HighlightResponse()

    seq = lemma_sequence(term)
    if not seq:
        return HighlightResponse()

    results = kiwi.analyze(sentence)
    if not results:
        return HighlightResponse()
    sent_tokens, _ = results[0]

    n = len(seq)
    match_start_char = None
    for i in range(len(sent_tokens) - n + 1):
        window = sent_tokens[i : i + n]
        if all(w.form == f and w.tag == g for w, (f, g) in zip(window, seq)):
            match_start_char = window[0].start
            break

    if match_start_char is None:
        return HighlightResponse()

    for s, e in eojeol_spans(sentence):
        if s <= match_start_char < e:
            text = sentence[s:e].rstrip(TRAILING_PUNCT)
            if not text:
                return HighlightResponse()
            return HighlightResponse(highlight=text, start=s, end=s + len(text))

    return HighlightResponse()


@app.get("/health")
def health():
    return {"ok": True}
