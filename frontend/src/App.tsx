import React, { useState } from 'react';
import { Mic, MicOff, Volume2, Sparkles, AlertCircle } from 'lucide-react';

interface ChatPayload {
  user_id: string;
  message: string;
}

export default function App() {
  const [isListening, setIsListening] = useState<boolean>(false);
  const [assistantText, setAssistantText] = useState<string>(
    'Dzień dobry! Naciśnij zielony mikrofon i powiedz mi, jak się dzisiaj czujesz.'
  );
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('Naciśnij przycisk, aby zacząć rozmowę');
  const [hasError, setHasError] = useState<boolean>(false);

  // Odtwarzanie głosu przez syntezator mowy przeglądarki
  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pl-PL';
    utterance.rate = 0.9; // Nieco wolniejsze tempo mowy dla seniora

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  // Rozpoznawanie mowy użytkownika (Speech-to-Text)
  const startVoiceInput = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Twoja przeglądarka nie obsługuje rozpoznawania mowy. Użyj Google Chrome lub Microsoft Edge.');
      return;
    }

    setHasError(false);
    const recognition = new SpeechRecognition();
    recognition.lang = 'pl-PL';
    recognition.interimResults = false;

    recognition.onstart = () => {
      setIsListening(true);
      setStatus('Słucham Cię uważnie...');
    };

    recognition.onresult = async (event: any) => {
      const transcript: string = event.results[0][0].transcript;
      setIsListening(false);
      setStatus('Już odpowiadam...');
      await handleStreamResponse(transcript);
    };

    recognition.onerror = () => {
      setIsListening(false);
      setStatus('Nie dosłyszałem. Spróbuj nacisnąć i powiedzieć jeszcze raz.');
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.start();
  };

  // Obsługa strumieniowania odpowiedzi z backendu FastAPI
  const handleStreamResponse = async (userPrompt: string) => {
    try {
      setAssistantText('');
      const payload: ChatPayload = {
        user_id: 'babcia_1',
        message: userPrompt,
      };

      const response = await fetch('http://127.0.0.1:8000/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.body) {
        throw new Error('Brak strumienia danych z serwera');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        setAssistantText((prev) => prev + chunk);
      }

      setStatus('Naciśnij przycisk, aby odpowiedzieć');
      speakText(fullText);
    } catch (err) {
      setHasError(true);
      setAssistantText('Przepraszam, wystąpił problem z połączeniem. Sprawdź, czy serwer działa.');
      setStatus('Błąd połączenia z backendem');
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between items-center p-6 select-none font-sans">
      {/* Górny pasek aplikacji */}
      <header className="w-full max-w-lg flex items-center justify-between py-4 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-bold tracking-wide">TalkApp</h1>
        </div>
        <span className="text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-full border border-emerald-500/20 font-semibold tracking-wider uppercase">
          Gotowy
        </span>
      </header>

      {/* Okno odpowiedzi asystenta */}
      <section className="w-full max-w-lg my-auto py-6">
        <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-2xl backdrop-blur-md transition-all">
          <div className="flex items-center gap-2 mb-4 text-slate-400 text-sm font-medium">
            <Volume2
              className={`w-5 h-5 ${isSpeaking ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`}
            />
            <span>Asystent:</span>
          </div>
          <p className="text-2xl sm:text-3xl leading-relaxed text-slate-50 font-normal min-h-[140px]">
            {assistantText}
          </p>
        </div>
      </section>

      {/* Przycisk sterowania i status */}
      <footer className="w-full max-w-lg flex flex-col items-center pb-8 gap-5">
        <button
          onClick={startVoiceInput}
          disabled={isListening}
          aria-label="Rozpocznij mówienie"
          className={`w-32 h-32 rounded-full flex items-center justify-center transition-all duration-300 shadow-2xl cursor-pointer ${
            isListening
              ? 'bg-rose-600 ring-8 ring-rose-500/40 scale-105 animate-pulse'
              : 'bg-emerald-500 hover:bg-emerald-400 active:scale-95 shadow-emerald-500/25'
          }`}
        >
          {isListening ? (
            <MicOff className="w-14 h-14 text-white" />
          ) : (
            <Mic className="w-14 h-14 text-white" />
          )}
        </button>

        <div className="flex items-center gap-2">
          {hasError && <AlertCircle className="w-4 h-4 text-rose-400" />}
          <p className={`text-base font-medium ${hasError ? 'text-rose-400' : 'text-slate-400'}`}>
            {status}
          </p>
        </div>
      </footer>
    </main>
  );
}