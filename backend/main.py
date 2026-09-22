import os
import re
import edge_tts
from fastapi import FastAPI, UploadFile, File, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from google import genai
from google.genai import types
import base64

import unicodedata

load_dotenv()

# Inicjalizacja Gemini
gemini_api_key = os.getenv("GEMINI_API_KEY")
client = genai.Client(api_key=gemini_api_key)

MODEL_NAME = "gemini-flash-latest"

app = FastAPI(title="TalkApp Backend - Gemini & Edge TTS")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = (
    
    
    "Twoje odpowiedzi powinny być zwięzłe (1-3 zdania) w języku polskim"

)

class ChatPayload(BaseModel):
    user_id: str
    message: str

class TTSPayload(BaseModel):
    text: str

def clean_text_for_speech(text: str) -> str:
    """Usuwa formatowanie Markdown, aby lektor czytał tylko czysty tekst."""
    text = re.sub(r'[*_~#`>\-]', '', text)
    return text.strip()

class TTSRequest(BaseModel):
    text: str

def remove_diacritics(text: str) -> str:
    """Usuwa znaki diakrytyczne (np. ą -> a, ł -> l) dla lepszego przetwarzania."""
    nfkd = unicodedata.normalize('NFKD', text)
    return "".join([c for c in nfkd if not unicodedata.combining(c)])


# 1. Transkrypcja nagrania audio z Gemini (ze ścisłym wskazaniem języka polskiego)
@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        response = await client.aio.models.generate_content(
            model=MODEL_NAME,
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type="audio/webm"),
                "Dokładnie przeanalizuj ten plik audio. Mówca posługuje się językiem polskim. "
                "Przepisz wypowiedź dosłownie w języku polskim. "
                "Zwróć wyłącznie rozpoznany tekst, bez komentarzy i wyjaśnień."
            ],
            config=types.GenerateContentConfig(
                system_instruction="Jesteś ekspertem ds. transkrypcji mowy w języku polskim. Zawsze przepisujesz mowę w języku polskim."
            )
        )
        return {"text": response.text.strip() if response.text else ""}
    except Exception as e:
        print(f"[BŁĄD TRANSKRYPCJI]: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# 2. Generator odpowiedzi tekstowej Gemini
async def gemini_stream_generator(user_prompt: str):
    try:
        response = await client.aio.models.generate_content_stream(
            model=MODEL_NAME,
            contents=user_prompt,
            config=types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT)
        )
        async for chunk in response:
            if chunk.text:
                yield chunk.text
    except Exception as e:
        yield f"Błąd: {str(e)}"

@app.post("/api/chat/stream")
async def chat_stream(payload: ChatPayload):
    return StreamingResponse(
        gemini_stream_generator(payload.message),
        media_type="text/plain; charset=utf-8"
    )

# 3. Synteza mowy - pobieranie słów bezpośrednio ze zdarzeń WordBoundary
@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    clean_text = clean_text_for_speech(req.text)
    if not clean_text:
        return {"audio": "", "words": [], "wtimes": [], "wdurations": []}

    voice = "pl-PL-MarekNeural"
    communicate = edge_tts.Communicate(clean_text, voice)
    submaker = edge_tts.SubMaker()
    
    audio_bytes = bytearray()

    try:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_bytes.extend(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                submaker.feed(chunk)

    except Exception as e:
        print(f"[BŁĄD EDGE-TTS]: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    words = []
    wtimes = []
    wdurations = []

    # Pobranie wyliczonych klatek czasowych z submakera
    for sub in submaker.cues:
        raw_word = sub.start
        # Konwersja timedelta na milisekundy
        start_ms = int(sub.start.total_seconds() * 1000)
        end_ms = int(sub.end.total_seconds() * 1000)
        duration_ms = max(50, end_ms - start_ms)

        clean_word = remove_diacritics(sub.line.strip(".,!?\"'()"))
        if clean_word:
            words.append(clean_word)
            wtimes.append(start_ms)
            wdurations.append(duration_ms)

    # Zapasowy algorytm podziału na wypadek braku cues
    if not words and clean_text:
        raw_words = [remove_diacritics(w.strip(".,!?\"'()")) for w in clean_text.split() if w.strip()]
        total_duration_ms = int((len(audio_bytes) * 8) / 128) # szacowany czas MP3 w ms
        avg_dur = max(100, int(total_duration_ms / max(1, len(raw_words))))
        
        curr = 0
        for w in raw_words:
            words.append(w)
            wtimes.append(curr)
            wdurations.append(avg_dur)
            curr += avg_dur

    audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
    
    return {
        "audio": audio_base64,
        "words": words,
        "wtimes": wtimes,
        "wdurations": wdurations
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)