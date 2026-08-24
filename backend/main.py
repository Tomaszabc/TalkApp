import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from google import genai
from google.genai import types

load_dotenv()

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Nazwa modelu Gemini
MODEL_NAME = "gemini-3.6-flash"

app = FastAPI(title="TalkApp Backend - Gemini")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = (
    "Jesteś ciepłym, cierpliwym i wspierającym asystentem głosowym dla osób starszych. "
    "Twoje odpowiedzi powinny być zwięzłe (1-3 zdania), naturalne, pełne szacunku i proste do zrozumienia w języku polskim."
)

class ChatPayload(BaseModel):
    user_id: str
    message: str

# 1. Transkrypcja nagrania audio
@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        print("\n[KROK 1] Otrzymano plik audio z przeglądarki...")
        audio_bytes = await file.read()
        print(f"[KROK 2] Rozmiar pliku: {len(audio_bytes)} bajtów. Przesyłam do Gemini...")

        response = await client.aio.models.generate_content(
            model=MODEL_NAME,
            contents=[
                types.Part.from_bytes(
                    data=audio_bytes,
                    mime_type="audio/webm"
                ),
                "Przepisz dosłownie treść tego nagrania na język polski. Zwróć wyłącznie sam rozpoznany tekst, bez żadnych dodatkowych uwag."
            ]
        )
        
        transcribed_text = response.text.strip() if response.text else ""
        print(f"[KROK 3] Sukces! Rozpoznany tekst: \"{transcribed_text}\"")
        return {"text": transcribed_text}

    except Exception as e:
        print(f"[BŁĄD TRANSKRYPCJI]: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# 2. Generator strumienia odpowiedzi
async def gemini_stream_generator(user_prompt: str):
    print(f"[KROK 4] Generuję odpowiedź dla pytania: \"{user_prompt}\"...")
    try:
        response = await client.aio.models.generate_content_stream(
            model=MODEL_NAME,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT
            )
        )
        async for chunk in response:
            if chunk.text:
                yield chunk.text
        print("[KROK 5] Zakończono generowanie odpowiedzi.")
    except Exception as e:
        print(f"[BŁĄD GENEROWANIA]: {e}")
        yield f"Błąd serwera: {str(e)}"

@app.post("/api/chat/stream")
async def chat_stream(payload: ChatPayload):
    return StreamingResponse(
        gemini_stream_generator(payload.message),
        media_type="text/plain; charset=utf-8"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)