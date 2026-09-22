import React, { useState, useRef, useEffect } from 'react';
import { Mic, Square, Volume2, Sparkles, Send, Loader2, Radio, User } from 'lucide-react';

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [assistantText, setAssistantText] = useState('Dzień dobry! Kliknij mikrofon lub włącz tryb ciągły, aby porozmawiać.');
  const [userText, setUserText] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState('Inicjalizacja awatara...');
  const [textInput, setTextInput] = useState('');

  // Tryb ciągły (Hands-Free)
  const [isHandsFree, setIsHandsFree] = useState(false);
  const isHandsFreeRef = useRef(isHandsFree);
  useEffect(() => {
    isHandsFreeRef.current = isHandsFree;
  }, [isHandsFree]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micAnimationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);

  // Instancja TalkingHead
  const avatarContainerRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<any>(null);

  const unlockAudioContext = () => {
    if (headRef.current?.audioCtx) {
      if (headRef.current.audioCtx.state === 'suspended') {
        headRef.current.audioCtx.resume().catch((err: any) => console.warn('Błąd odblokowania AudioContext:', err));
      }
    }
  };

  // Inicjalizacja TalkingHead
  useEffect(() => {
    let isMounted = true;

    async function initAvatar() {
      if (!avatarContainerRef.current || headRef.current) return;
      try {
        const module = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/modules/talkinghead.mjs');
        const TalkingHead = module.TalkingHead;

        const head = new TalkingHead(avatarContainerRef.current, {
          cameraView: 'head',
          cameraDistance: 0.6,
          cameraX: 0,
          cameraY: 0,
          avatarMood: 'neutral',
          lipsyncModules: ['en', 'fi'],
          mixerGainSpeech: 1
        });

        await head.showAvatar({
          url: '/model.glb',
          body: 'F',
          avatarMood: 'neutral',
          lipsyncLang: 'fi'
        });

        if (isMounted) {
          headRef.current = head;
          setStatus('Gotowy do rozmowy');
          console.log('✅ Awatar załadowany pomyślnie!', head);
        }
      } catch (err: any) {
        console.error('[AVATAR ERROR]:', err);
        if (isMounted) setStatus(`Błąd awatara: ${err.message || err}`);
      }
    }

    initAvatar();

    return () => {
      isMounted = false;
      if (headRef.current) {
        headRef.current.stop();
        headRef.current = null;
      }
    };
  }, []);

  const cleanupMicContext = () => {
    if (micAnimationFrameRef.current) cancelAnimationFrame(micAnimationFrameRef.current);
    if (micAudioContextRef.current && micAudioContextRef.current.state !== 'closed') {
      micAudioContextRef.current.close().catch(console.error);
    }
  };

  useEffect(() => cleanupMicContext, []);

  // Odtwarzanie dźwięku i synchronizacja ust
  const playBackendTTS = async (text: string) => {
    if (!text.trim()) return;

    try {
      setStatus('Marek przygotowuje odpowiedź...');
      setIsSpeaking(true);

      const response = await fetch('http://127.0.0.1:8000/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Błąd HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // DIAGNOSTYKA ODPOWIEDZI BACKENDU
      console.group('🔍 ODPOWIEDŹ Z BACKENDU (/api/tts)');
      console.log('Słowa (words):', data.words);
      console.log('Czasy startu (wtimes):', data.wtimes);
      console.log('Czasy trwania (wdurations):', data.wdurations);
      console.log('Długość ciągu Audio (base64 length):', data.audio ? data.audio.length : 0);
      
      if (!data.words || data.words.length === 0) {
        console.error('❌ PROBLEM: Backend przekazał pusta tablicę "words". Usta nie będą się ruszać.');
      }
      console.groupEnd();

      if (!headRef.current) {
        throw new Error('TalkingHead nie jest zainicjalizowany');
      }

      // base64 -> ArrayBuffer
      const binaryString = window.atob(data.audio);
      const bytes = new Uint8Array(binaryString.length);

      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const arrayBuffer = bytes.buffer;

      // AudioContext TalkingHead
      const audioCtx = headRef.current.audioCtx;

      if (!audioCtx) {
        throw new Error('TalkingHead nie posiada AudioContext');
      }

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // MP3 -> AudioBuffer
      const audioBuffer = await audioCtx.decodeAudioData(
        arrayBuffer.slice(0)
      );

      setStatus('Marek odpowiada...');

      // Wywołanie mowy awatara
      headRef.current.speakAudio(
        {
          audio: audioBuffer,
          words: data.words || [],
          wtimes: data.wtimes || [],
          wdurations: (data.wdurations || []).map((d: number) => d * 2)
        },
        {
          lipsyncLang: 'fi'
        }
      );

      headRef.current.speakMarker(() => {
        setIsSpeaking(false);

        if (isHandsFreeRef.current) {
          setStatus('Słucham Cię ponownie...');
          setTimeout(() => {
            if (isHandsFreeRef.current) {
              startRecording();
            }
          }, 400);
        } else {
          setStatus('Dotknij mikrofonu, aby odpowiedzieć');
        }
      });

    } catch (err: any) {
      console.error('[TTS ERROR]:', err);
      setIsSpeaking(false);
      setStatus(`Błąd mowy: ${err.message || err}`);
    }
  };

  const startRecording = async () => {
    unlockAudioContext();
    try {
      if (headRef.current) headRef.current.stopSpeaking();
      setIsSpeaking(false);
      cleanupMicContext();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        cleanupMicContext();
        await sendAudioToBackend(new Blob(audioChunksRef.current, { type: 'audio/webm' }));
      };

      mediaRecorder.start();
      setIsRecording(true);
      setStatus('Słucham... (powiedz coś)');

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      micAudioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.minDecibels = -85;
      analyser.smoothingTimeConstant = 0.8;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      silenceStartRef.current = null;
      let hasSpoken = false;

      const checkSilence = () => {
        if (mediaRecorder.state !== 'recording') return;

        analyser.getByteFrequencyData(dataArray);
        const averageVolume = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;

        if (averageVolume > 14) {
          hasSpoken = true;
          silenceStartRef.current = null;
        } else {
          if (silenceStartRef.current === null) {
            silenceStartRef.current = Date.now();
          } else {
            const silentDuration = Date.now() - silenceStartRef.current;
            if (hasSpoken && silentDuration > 1800) { stopRecording(); return; }
            if (!hasSpoken && silentDuration > 10000 && !isHandsFreeRef.current) { stopRecording(); return; }
          }
        }
        micAnimationFrameRef.current = requestAnimationFrame(checkSilence);
      };

      checkSilence();
    } catch (err) {
      console.error(err);
      setStatus('Brak dostępu do mikrofonu');
      setIsHandsFree(false);
    }
  };

  const stopRecording = () => {
    unlockAudioContext();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      cleanupMicContext();
      setIsRecording(false);
      setIsLoading(true);
      setStatus('Przetwarzam wypowiedź...');
    }
  };

  const sendAudioToBackend = async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');
      const response = await fetch('http://127.0.0.1:8000/api/transcribe', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Błąd transkrypcji');
      const data = await response.json();

      if (data.text.trim()) {
        setUserText(data.text);
        await handleStreamResponse(data.text);
      } else {
        if (isHandsFreeRef.current) {
          setStatus('Nie usłyszałem. Słucham ponownie...');
          setIsLoading(false);
          setTimeout(() => startRecording(), 500);
        } else {
          setStatus('Nie usłyszałem wypowiedzi.');
          setIsLoading(false);
        }
      }
    } catch (err) {
      setStatus('Błąd transkrypcji');
      setIsLoading(false);
    }
  };

  const handleStreamResponse = async (userPrompt: string) => {
    try {
      setIsLoading(false);
      setStatus('Generuję odpowiedź...');
      setAssistantText('');

      const response = await fetch('http://127.0.0.1:8000/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'senior_1', message: userPrompt }),
      });

      if (!response.ok) throw new Error(`Błąd HTTP: ${response.status}`);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullText = '';

      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          setAssistantText((prev) => prev + chunk);
        }
      }
      await playBackendTTS(fullText);
    } catch (err: any) {
      setAssistantText(`Wystąpił problem: ${err.message}`);
      setStatus('Błąd połączenia');
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    unlockAudioContext();
    if (!textInput.trim() || isLoading) return;
    const msg = textInput;
    setUserText(msg);
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
        <button
          onClick={() => {
            unlockAudioContext();
            const nextState = !isHandsFree;
            setIsHandsFree(nextState);
            if (nextState && !isRecording && !isSpeaking && !isLoading) startRecording();
            else if (!nextState && isRecording) stopRecording();
          }}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
            isHandsFree ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300' : 'bg-slate-900 border-slate-800 text-slate-400'
          }`}
        >
          <Radio className={`w-3.5 h-3.5 ${isHandsFree ? 'animate-pulse text-emerald-400' : ''}`} />
          <span>{isHandsFree ? 'Tryb ciągły: WŁ' : 'Tryb ciągły: WYŁ'}</span>
        </button>
      </header>

      <section className="w-full max-w-lg my-auto py-4 space-y-4">
        {userText && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-1.5 animate-fade-in">
            <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-wider">
              <User className="w-4 h-4" />
              <span>Ty powiedziałaś / powiedziałeś:</span>
            </div>
            <p className="text-sm text-slate-200 leading-relaxed font-medium pl-6">
              "{userText}"
            </p>
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-4">
          <div className="w-full h-80 bg-slate-950 rounded-2xl overflow-hidden relative border border-slate-800/60 shadow-inner">
            <div ref={avatarContainerRef} className="w-full h-full" />
          </div>

          <div className="flex items-center justify-center gap-2 text-slate-400 text-sm font-medium pt-2 border-t border-slate-800/80">
            <Volume2 className={`w-5 h-5 ${isSpeaking ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
            <span>Marek:</span>
          </div>

          <p className="text-lg leading-relaxed text-slate-100 min-h-[60px] text-center italic">
            {assistantText}
          </p>
        </div>
      </section>

      <footer className="w-full max-w-lg flex flex-col items-center pb-6 gap-4">
        <form onSubmit={handleFormSubmit} className="w-full flex gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            disabled={isLoading || isRecording}
            placeholder="Wpisz wiadomość..."
            className="flex-1 bg-slate-900 border border-slate-800 rounded-full px-5 py-3 text-sm focus:outline-none focus:border-emerald-500 text-white disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading || isRecording}
            className="bg-emerald-600 hover:bg-emerald-500 p-3 rounded-full text-white cursor-pointer disabled:opacity-50"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>

        <button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isLoading}
          className={`w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 shadow-xl cursor-pointer ${
            isRecording ? 'bg-rose-600 ring-8 ring-rose-500/30 scale-105 animate-pulse' : 'bg-emerald-500 hover:bg-emerald-400 active:scale-95'
          } ${isLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {isLoading ? (
            <Loader2 className="w-10 h-10 text-white animate-spin" />
          ) : isRecording ? (
            <Square className="w-8 h-8 text-white fill-white" />
          ) : (
            <Mic className="w-10 h-10 text-white" />
          )}
        </button>

        <p className="text-sm font-medium text-slate-400">{status}</p>
      </footer>
    </main>
  );
}