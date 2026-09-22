import os
import re
import json
import base64
import unicodedata
import edge_tts
import asyncio
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from google import genai
from google.genai import types

load_dotenv()

app = FastAPI(title="TalkApp Backend - Gemini & Edge TTS with Fast Streaming")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Inicjalizacja klienta Google GenAI ze stabilnym i szybkim modelem
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
client = genai.Client(api_key=GEMINI_API_KEY)
MODEL_NAME = "gemini-flash-latest"

MEMORY_FILE = "babcia_memory.json"

def split_into_sentences(text_buffer):
    """Wyciąga pełne zdania z bufora tekstu po kropkach, pytajnikach i wykrzyknikach."""
    sentences = re.split(r'(?<=[.!?])\s+', text_buffer)
    if len(sentences) > 1:
        return sentences[:-1], sentences[-1]
    return [], text_buffer


# --- ZARZĄDZANIE PAMIĘCIĄ BABCII ---

def load_memory() -> dict:
    if os.path.exists(MEMORY_FILE):
        try:
            with open(MEMORY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"fakty": [], "historia": []}

def save_memory(data: dict):
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def clean_text_for_speech(text: str) -> str:
    """Usuwa formatowanie Markdown, aby lektor czytał czysty tekst."""
    text = re.sub(r'[*_~#`>\-]', '', text)
    return text.strip()

def remove_diacritics(text: str) -> str:
    """Usuwa znaki diakrytyczne na potrzeby lip-sync w TalkingHead."""
    nfkd = unicodedata.normalize('NFKD', text)
    return "".join([c for c in nfkd if not unicodedata.combining(c)])

class ChatPayload(BaseModel):
    user_id: str = "babcia"
    message: str

class TTSRequest(BaseModel):
    text: str


# --- 1. TRANSKRYPCJA AUDIO (STT) ---

@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        response = await client.aio.models.generate_content(
            model=MODEL_NAME,
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type="audio/webm"),
                "Dokładnie przeanalizuj ten plik audio. Jeśli w nagraniu słychać wyraźną mowę w języku polskim, "
                "przepisz ją dosłownie. JEŚLI W NAGRANIU JEST TYLKO SZUM, CISZA LUB NIEZROZUMIAŁY DŹWIĘK, "
                "ZWRÓĆ DOKŁADNIE SŁOWO: BRAK"
            ],
            config=types.GenerateContentConfig(
                system_instruction="Jesteś ekspertem ds. transkrypcji mowy w języku polskim. Zawsze przepisujesz mowę w języku polskim."
            )
        )
        
        raw_text = response.text.strip() if response.text else ""
        
        if "BRAK" in raw_text.upper() or len(raw_text) < 3:
            return {"text": ""}
            
        return {"text": raw_text}
    except Exception as e:
        print(f"[BŁĄD TRANSKRYPCJI]: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- 2. STRUMIENIOWANIE CZATU Z AUDIO (ENDPOINT OBSŁUGUJĄCY /api/chat/stream) ---

@app.post("/api/chat/stream")
async def chat_stream(payload: ChatPayload):
    """Zwraca strumień gotowych fragmentów TTS od razu po wygenerowaniu zdania."""
    memory_data = load_memory()
    fakty_str = "\n".join([f"- {f}" for f in memory_data.get("fakty", [])])
    
    system_instruction = f"""Nazywasz się Marek. Jesteś ciepłym, cierpliwym i serdecznym asystentem rozmawiającym ze starszą osobą (Babcią).

ZASADY ROZMOWY:
1. Rozmawiasz z babcią, jesteś tu po to żeby z nią rozmawiać, opowiadać jej i być jej towarzyszem.
2. Używaj prostego języka
3. Odwołuj się do wiedzy o babci, jeśli to pasuje do kontekstu.
5. Miała męża Janka, który zmarł w dzień rocznicy objawień Fatimskich.

Oto co już wiesz o babci z poprzednich rozmów:
{fakty_str if fakty_str else "- Na razie jeszcze się poznajecie."}"""

    raw_history = memory_data.get("historia", [])
    trimmed_history = raw_history[-20:] if len(raw_history) > 20 else raw_history

    contents = []
    for msg in trimmed_history:
        contents.append(types.Content(
            role=msg["role"],
            parts=[types.Part.from_text(text=t) for t in msg["parts"]]
        ))
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=payload.message)]))

    async def audio_sentence_generator():
        full_text_response = ""
        buffer = ""

        # Wywołanie generowania odpowiedzi z obsługą wyszukiwania w Google
        response_stream = await client.aio.models.generate_content_stream(
            model=MODEL_NAME,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                tools=[{"google_search": {}}]
            )
        )

        async for chunk in response_stream:
            if chunk.text:
                full_text_response += chunk.text
                buffer += chunk.text
                
                sentences, buffer = split_into_sentences(buffer)
                for sentence in sentences:
                    tts_data = await generate_tts_for_sentence(sentence)
                    if tts_data:
                        yield json.dumps(tts_data) + "\n"

        if buffer.strip():
            tts_data = await generate_tts_for_sentence(buffer.strip())
            if tts_data:
                yield json.dumps(tts_data) + "\n"

        # Zapis historii w pamięci
        updated_history = trimmed_history + [
            {"role": "user", "parts": [payload.message]},
            {"role": "model", "parts": [full_text_response]}
        ]
        memory_data["historia"] = updated_history
        save_memory(memory_data)
        
        # Ekstrakcja nowych faktów w tle
        asyncio.create_task(extract_facts_about_babcia(payload.message))

    return StreamingResponse(audio_sentence_generator(), media_type="application/x-ndjson")


async def generate_tts_for_sentence(text: str):
    """Generuje dane TTS i lip-sync dla pojedynczego zdania."""
    clean_text = clean_text_for_speech(text)
    if not clean_text:
        return None

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
    except Exception:
        return None

    words, wtimes, wdurations = [], [], []
    for sub in submaker.cues:
        start_ms = int(sub.start.total_seconds() * 1000)
        end_ms = int(sub.end.total_seconds() * 1000)
        clean_word = remove_diacritics(sub.line.strip(".,!?\"'()"))
        if clean_word:
            words.append(clean_word)
            wtimes.append(start_ms)
            wdurations.append(max(50, end_ms - start_ms))

    return {
        "text": text,
        "audio": base64.b64encode(audio_bytes).decode('utf-8'),
        "words": words,
        "wtimes": wtimes,
        "wdurations": wdurations
    }


async def extract_facts_about_babcia(user_msg: str):
    """Ciche zapytanie w tle do zapamiętywania faktów o babci."""
    try:
        prompt = f"""Przeanalizuj poniższą wypowiedź Babci i wyciągnij z niej trwałe fakty o jej życiu, rodzinie, zdrowiu, preferencjach lub wspomnieniach.
        
Wypowiedź Babci: "{user_msg}"

Wygeneruj wyłącznie krótkie punkty z faktami (po jednym w linii). Jeśli wypowiedź nie zawiera żadnych nowych faktów personalnych, odpowiedz słowem "BRAK".
"""
        res = await client.aio.models.generate_content(
            model=MODEL_NAME,
            contents=prompt
        )
        text = res.text.strip() if res.text else ""
        
        if text and "BRAK" not in text:
            memory_data = load_memory()
            new_facts = [line.strip("- ").strip() for line in text.split("\n") if line.strip()]
            
            for fact in new_facts:
                if fact and fact not in memory_data["fakty"]:
                    memory_data["fakty"].append(fact)
            
            save_memory(memory_data)
            print(f"🧠 ZAPAMIĘTANO NOWE FAKTY: {new_facts}")
    except Exception as e:
        print(f"[BŁĄD ZAPAMIĘTYWANIA FAKTU]: {e}")


# --- 3. SYNTEZA MOWY (TTS STANDARDOWY DLA ZAPYTAN Z FRONTENDU) ---

@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    data = await generate_tts_for_sentence(req.text)
    if not data:
        return {"audio": "", "words": [], "wtimes": [], "wdurations": []}
    return data


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)