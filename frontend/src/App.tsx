import React, { useState, useRef, useEffect } from 'react';
import { Volume2, Mic, Play, Loader2 } from 'lucide-react';

export default function App() {
  const [isStarted, setIsStarted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [assistantText, setAssistantText] = useState('Dzień dobry! Jestem gotowy do rozmowy.');
  const [userText, setUserText] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('Ładowanie awatara...');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micAnimationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);

  const avatarContainerRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<any>(null);

  const unlockAudioContext = () => {
    if (headRef.current?.audioCtx && headRef.current.audioCtx.state === 'suspended') {
      headRef.current.audioCtx.resume().catch(console.warn);
    }
  };

  // 1. Ładowanie Awatara
  useEffect(() => {
    let isMounted = true;

    async function initAvatar() {
      if (!avatarContainerRef.current || headRef.current) return;
      try {
        // @ts-ignore
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
          setStatus('Naciśnij przycisk, aby rozpocząć');
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

  // 2. Funkcja pomocnicza do odtwarzania pojedynczego fragmentu zdania w TalkingHead
  const playAudioChunk = (data: { text: string; audio: string; words: string[]; wtimes: number[]; wdurations: number[] }): Promise<void> => {
    return new Promise(async (resolve) => {
      try {
        if (!data.audio || !headRef.current) {
          resolve();
          return;
        }

        setAssistantText((prev) => (prev ? `${prev} ${data.text}` : data.text));

        const binaryString = window.atob(data.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const audioCtx = headRef.current.audioCtx;
        if (audioCtx && audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }

        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));

        setIsSpeaking(true);
        setStatus('Marek odpowiada...');

        const SLOW_FACTOR = 1.0;

        headRef.current.speakAudio(
          {
            audio: audioBuffer,
            words: data.words || [],
            wtimes: (data.wtimes || []).map((t: number) => t * SLOW_FACTOR),
            wdurations: (data.wdurations || []).map((d: number) => d * SLOW_FACTOR)
          },
          { lipsyncLang: 'fi' }
        );

        headRef.current.speakMarker(() => {
          resolve();
        });
      } catch (err) {
        console.error('[PLAY CHUNK ERROR]:', err);
        resolve();
      }
    });
  };

  // 3. Nasłuch mikrofonu (Sekwencyjny)
  const startRecording = async () => {
    unlockAudioContext();
    cleanupMicContext();

    try {
      if (headRef.current) headRef.current.stopSpeaking();
      setIsSpeaking(false);

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
        setIsRecording(false);
        await sendAudioToBackend(new Blob(audioChunksRef.current, { type: 'audio/webm' }));
      };

      mediaRecorder.start();
      setIsRecording(true);
      setStatus('Słucham Cię...');

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

        if (averageVolume > 22) {
          hasSpoken = true;
          silenceStartRef.current = null;
        } else {
          if (silenceStartRef.current === null) {
            silenceStartRef.current = Date.now();
          } else {
            const silentDuration = Date.now() - silenceStartRef.current;
            // 3.5 sekundy ciszy = koniec wypowiedzi babci
            if (hasSpoken && silentDuration > 3500) {
              stopRecording();
              return;
            }
          }
        }
        micAnimationFrameRef.current = requestAnimationFrame(checkSilence);
      };

      checkSilence();
    } catch (err) {
      console.error(err);
      setStatus('Błąd mikrofonu. Ponawiam...');
      restartListeningLater(3000);
    }
  };

  const stopRecording = () => {
    unlockAudioContext();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      cleanupMicContext();
      setIsLoading(true);
      setStatus('Przetwarzam wypowiedź...');
    }
  };

  const restartListeningLater = (delayMs = 400) => {
    setTimeout(() => {
      startRecording();
    }, delayMs);
  };

  const sendAudioToBackend = async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');
      const response = await fetch('http://127.0.0.1:8000/api/transcribe', { method: 'POST', body: formData });
      
      if (!response.ok) throw new Error('Błąd transkrypcji');
      const data = await response.json();

      if (data.text && data.text.trim()) {
        setUserText(data.text);
        await handleStreamResponse(data.text);
      } else {
        setIsLoading(false);
        restartListeningLater(300);
      }
    } catch (err) {
      setIsLoading(false);
      restartListeningLater(2000);
    }
  };

  // 4. Odbieranie odpowiedzi ze strumienia i płynne odtwarzanie zdań
  const handleStreamResponse = async (userPrompt: string) => {
    try {
      setIsLoading(false);
      setStatus('Generuję odpowiedź...');
      setAssistantText('');

      const response = await fetch("http://127.0.0.1:8000/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userPrompt }), // Poprawiono: przekazujemy userPrompt
      });

      if (!response.ok) throw new Error(`Błąd HTTP ${response.status}`);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let partialLine = "";

      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        
        partialLine += decoder.decode(value, { stream: true });
        const lines = partialLine.split("\n");
        partialLine = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              // Odtwarzamy zdanie po zdaniu i czekamy na zakończenie każdego z nich
              await playAudioChunk(data);
            } catch (jsonErr) {
              console.error("[JSON PARSE ERROR]:", jsonErr);
            }
          }
        }
      }

      // Ostatni pozostały fragment
      if (partialLine.trim()) {
        try {
          const data = JSON.parse(partialLine);
          await playAudioChunk(data);
        } catch (jsonErr) {
          console.error("[JSON PARSE ERROR]:", jsonErr);
        }
      }

      setIsSpeaking(false);
      restartListeningLater(400);

    } catch (err: any) {
      console.error("[STREAM ERROR]:", err);
      setAssistantText('Wystąpił problem z połączeniem.');
      setIsSpeaking(false);
      setIsLoading(false);
      restartListeningLater(3000);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between items-center p-6 select-none font-sans relative overflow-hidden">
      
      {!isStarted && (
        <div className="absolute inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center">
          <div className="max-w-lg space-y-8 bg-slate-900 border border-slate-800 p-10 rounded-3xl shadow-2xl">
            <h1 className="text-4xl font-extrabold text-emerald-400">Asystent dla Babci</h1>
            <p className="text-2xl text-slate-300 leading-relaxed">
              Kliknij poniższy przycisk, aby zacząć rozmowę.
            </p>
            <button
              onClick={() => {
                setIsStarted(true);
                unlockAudioContext();
                startRecording();
              }}
              className="w-full py-8 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-3xl rounded-2xl shadow-xl transition-all active:scale-95 flex items-center justify-center gap-4 cursor-pointer"
            >
              <Play className="w-10 h-10 fill-current" />
              <span>ROZPOCZNIJ</span>
            </button>
          </div>
        </div>
      )}

      <section className="w-full max-w-3xl my-auto space-y-6">
        {userText && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg">
            <span className="text-emerald-400 text-sm font-bold uppercase tracking-wider block mb-1">
              Babcia powiedziała:
            </span>
            <p className="text-2xl text-slate-100 font-medium">"{userText}"</p>
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-6">
          <div className="w-full h-96 bg-slate-950 rounded-2xl overflow-hidden relative border border-slate-800/80 shadow-inner">
            <div ref={avatarContainerRef} className="w-full h-full" />

            <div className="absolute top-4 left-4 bg-slate-900/90 border border-slate-700 px-4 py-2 rounded-full flex items-center gap-3">
              {isSpeaking ? (
                <>
                  <Volume2 className="w-5 h-5 text-emerald-400 animate-pulse" />
                  <span className="text-emerald-400 font-bold">MÓWIĘ...</span>
                </>
              ) : isRecording ? (
                <>
                  <span className="w-3.5 h-3.5 bg-rose-500 rounded-full animate-ping" />
                  <span className="text-rose-400 font-bold">SŁUCHAM...</span>
                </>
              ) : isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                  <span className="text-amber-400 font-bold">MYŚLĘ...</span>
                </>
              ) : (
                <span className="text-slate-400 font-medium">{status}</span>
              )}
            </div>
          </div>

          <div className="p-4 bg-slate-950/60 rounded-2xl border border-slate-800/80 min-h-[90px] flex items-center justify-center">
            <p className="text-2xl font-medium leading-relaxed text-slate-100 text-center">
              {assistantText}
            </p>
          </div>
        </div>
      </section>

      <footer className="w-full max-w-md flex flex-col items-center pb-4">
        <div className={`p-5 rounded-full transition-all duration-300 ${
          isSpeaking ? 'bg-emerald-500/20 border-2 border-emerald-500' :
          isRecording ? 'bg-rose-500/20 border-2 border-rose-500 scale-110' : 'bg-slate-900 border border-slate-800'
        }`}>
          <Mic className={`w-10 h-10 ${isSpeaking ? 'text-emerald-400' : isRecording ? 'text-rose-500 animate-pulse' : 'text-slate-500'}`} />
        </div>
        <p className="text-lg font-semibold text-slate-400 mt-2">{status}</p>
      </footer>
    </main>
  );
}