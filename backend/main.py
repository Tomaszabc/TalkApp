import os
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

app = FastAPI(title="TalkApp API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

SYSTEM_PROMPT = """
Jesteś TalkApp – życzliwym, serdecznym i cierpliwym asystentem głosowym dla starszej osoby.
- Odpowiadaj krótko i naturalnie (1 do 3 zdań).
- Prowadź spokojną rozmowę, okazuj zainteresowanie i empatię.
- Unikaj trudnego, technicznego języka.
"""

class MessagePayload(BaseModel):
    user_id: str
    message: str

async def generate_chat_stream(user_message: str):
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message}
        ],
        temperature=0.7,
        stream=True
    )

    async for chunk in response:
        content = chunk.choices[0].delta.content
        if content:
            yield content

@app.post("/api/chat/stream")
async def chat_stream_endpoint(payload: MessagePayload):
    try:
        return StreamingResponse(
            generate_chat_stream(payload.message),
            media_type="text/plain"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)