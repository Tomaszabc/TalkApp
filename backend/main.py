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
    "Jestes bogiem, odpowiadaj krotko, rozmawiasz z babcia stara, rob sobie jaja"
    # "Jesteś ciepłym, cierpliwym i wspierającym asystentem głosowym dla osób starszych. "
    # "Twoje odpowiedzi powinny być zwięzłe (1-3 zdania), naturalne, pełne szacunku i proste do zrozumienia w języku polskim."
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

# 1. Transkrypcja nagrania audio z Gemini
@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        response = await client.aio.models.generate_content(
            model=MODEL_NAME,
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type="audio/webm"),
                "Przepisz dosłownie treść tego nagrania na tekst w języku polskim. Zwróć wyłącznie sam rozpoznany tekst, bez żadnych dodatkowych uwag."
            ]
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

# 3. Synteza mowy (Darmowy kobiecy głos neuronowy: Zofia)
@app.post("/api/tts")
async def text_to_speech(payload: TTSPayload):
    try:
        cleaned_text = clean_text_for_speech(payload.text)
        if not cleaned_text:
            raise HTTPException(status_code=400, detail="Brak tekstu do odczytania")

        # pl-PL-ZofiaNeural to oficjalny polski żeński głos neuronowy Edge
        communicate = edge_tts.Communicate(
            text=cleaned_text,
            voice="pl-PL-ZofiaNeural",
            rate="-4%"
        )
        
        audio_data = bytearray()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data.extend(chunk["data"])

        return Response(content=bytes(audio_data), media_type="audio/mpeg")

    except Exception as e:
        print(f"[BŁĄD TTS]: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)