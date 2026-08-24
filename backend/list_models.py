import os
from dotenv import load_dotenv
from google import genai

load_dotenv()
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

print("\n--- TWOJE DOSTĘPNE MODELE ---")
for m in client.models.list():
    if "generateContent" in m.supported_actions:
        # Usuwamy przedrostek 'models/', jeśli występuje
        name = m.name.replace("models/", "")
        print(f"MODEL_NAME = \"{name}\"")