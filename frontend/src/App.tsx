import React, { useState, useRef } from 'react';
import { Mic, Square, Volume2, Sparkles, Send, Loader2 } from 'lucide-react';

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [assistantText, setAssistantText] = useState('Dzień dobry! Dotknij mikrofonu i powiedz, jak się dzisiaj czujesz.');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState('Naciśnij mikrofon, aby nagrać');
  const [textInput, setTextInput] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Odtwarzanie głosu przez syntezator
  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pl-PL';
    utterance.rate = 0.9;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  // Rozpoczęcie nagrywania dźwięku z mikrofonu
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Zatrzymanie strumienia mikrofonu
        stream.getTracks().forEach((track) => track.stop());
        
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await sendAudioToWhisper(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setStatus('Słucham... Naciśnij kwadrat, aby zakończyć');
    } catch (err) {
      console.error('Błąd dostępu do mikrofonu:', err);
      setStatus('Błąd: Brak uprawnień do mikrofonu');
    }
  };

  // Zatrzymanie nagrywania i wysyłka
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsLoading(true);
      setStatus('Przetwarzam głos przez OpenAI Whisper...');
    }
  };

  // Wysłanie pliku audio do backendu
  const sendAudioToWhisper = async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');

      const response = await fetch('http://127.0.0.1:8000/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Błąd transkrypcji audio');
      
      const data = await response.json();
      console.log('Rozpoznano przez Whisper:', data.text);

      if (data.text.trim()) {
        await handleStreamResponse(data.text);
      } else {
        setStatus('Nie usłyszałem wypowiedzi. Spróbuj ponownie.');
        setIsLoading(false);
      }
    } catch (err: any) {
      console.error(err);
      setStatus('Błąd transkrypcji mowy');
      setIsLoading(false);
    }
  };

  // Strumieniowanie odpowiedzi GPT-4o
  const handleStreamResponse = async (userPrompt: string) => {
    try {
      setIsLoading(false);
      setStatus('Odpowiadam...');
      setAssistantText('');

      const response = await fetch('http://127.0.0.1:8000/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'babcia_1', message: userPrompt }),
      });

      if (!response.ok) throw new Error(`Błąd HTTP: ${response.status}`);
      if (!response.body) throw new Error('Brak strumienia danych');

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

      setStatus('Dotknij mikrofonu, aby odpowiedzieć');
      speakText(fullText);
    } catch (err: any) {
      console.error(err);
      setAssistantText(`Wystąpił problem: ${err.message}`);
      setStatus('Błąd połączenia');
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || isLoading) return;
    const msg = textInput;
    setTextInput('');
    handleStreamResponse(msg);
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between items-center p-6 select-none font-sans">
      <header className="w-full max-w-lg flex items-center justify-between py-4 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-bold">TalkApp</h1>
        </div>
        <span className="text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full border border-emerald-500/20 font-semibold tracking-wide uppercase">
          OpenAI Powered
        </span>
      </header>

      {/* Okno odpowiedzi asystenta */}
      <section className="w-full max-w-lg my-auto py-6">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl">
          <div className="flex items-center gap-2 mb-3 text-slate-400 text-sm font-medium">
            <Volume2 className={`w-5 h-5 ${isSpeaking ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
            <span>Asystent:</span>
          </div>
          <p className="text-2xl leading-relaxed text-slate-50 min-h-[120px]">
            {assistantText}
          </p>
        </div>
      </section>

      {/* Przyciski i kontrolki */}
      <footer className="w-full max-w-lg flex flex-col items-center pb-6 gap-4">
        <form onSubmit={handleFormSubmit} className="w-full flex gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Możesz też wpisać tekst..."
            disabled={isLoading || isRecording}
            className="flex-1 bg-slate-900 border border-slate-800 rounded-full px-5 py-3 text-sm focus:outline-none focus:border-emerald-500 text-white disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading || isRecording}
            className="bg-emerald-600 hover:bg-emerald-500 p-3 rounded-full text-white cursor-pointer disabled:opacity-50 transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>

        <button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isLoading}
          className={`w-28 h-28 rounded-full flex items-center justify-center transition-all duration-300 shadow-xl cursor-pointer ${
            isRecording
              ? 'bg-rose-600 ring-8 ring-rose-500/30 scale-105 animate-pulse'
              : 'bg-emerald-500 hover:bg-emerald-400 active:scale-95'
          } ${isLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {isLoading ? (
            <Loader2 className="w-12 h-12 text-white animate-spin" />
          ) : isRecording ? (
            <Square className="w-10 h-10 text-white fill-white" />
          ) : (
            <Mic className="w-12 h-12 text-white" />
          )}
        </button>

        <p className="text-sm font-medium text-slate-400">{status}</p>
      </footer>
    </main>
  );
}