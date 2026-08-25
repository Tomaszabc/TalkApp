import React, { useState, useRef, useEffect, Suspense, useMemo } from 'react';
import { Mic, Square, Volume2, Sparkles, Send, Loader2, Radio } from 'lucide-react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Lipsync } from 'wawa-lipsync';

// --- INICJALIZACJA WAWA-LIPSYNC ---
const lipsyncManager = new Lipsync();

// --- PROCEDURALNY ASYSTENT 3D (Bez zewnętrznych plików .glb!) ---
function ProceduralAssistant({ audioPlayerRef, isSpeaking }: { audioPlayerRef: React.RefObject<HTMLAudioElement>, isSpeaking: boolean }) {
  const meshRef = useRef<any>(null);

  useEffect(() => {
    if (audioPlayerRef.current) {
      try {
        lipsyncManager.connectAudio(audioPlayerRef.current);
      } catch (e) {}
    }
  }, [audioPlayerRef]);

  useFrame((state) => {
    if (isSpeaking) {
      lipsyncManager.processAudio();
    }

    const viseme = isSpeaking ? lipsyncManager.viseme?.toUpperCase() : null;
    
    if (meshRef.current) {
      const time = state.clock.getElapsedTime();
      
      meshRef.current.position.y = Math.sin(time * 2) * 0.1;
      
      let scaleX = 1;
      let scaleY = 1;
      let scaleZ = 1;

      if (viseme) {
        if (viseme === 'O' || viseme === 'U') {
          scaleZ = 1.3;
          scaleX = 0.9;
          scaleY = 0.9;
        } else if (viseme === 'A' || viseme === 'E') {
          scaleY = 1.2;
          scaleX = 1.1;
        } else if (viseme === 'M' || viseme === 'P' || viseme === 'B') {
          scaleY = 0.95;
          scaleX = 1.05;
        } else {
          scaleY = 1.05;
          scaleZ = 1.05;
        }
      }

      meshRef.current.scale.x += (scaleX - meshRef.current.scale.x) * 0.2;
      meshRef.current.scale.y += (scaleY - meshRef.current.scale.y) * 0.2;
      meshRef.current.scale.z += (scaleZ - meshRef.current.scale.z) * 0.2;
    }
  });

  return (
    <mesh ref={meshRef}>
      {/* Tutaj natywnie wykorzystujemy SphereGeometry */}
      <sphereGeometry args={[1.5, 64, 64]} />
      <meshPhysicalMaterial 
        color={isSpeaking ? "#10b981" : "#475569"} 
        metalness={0.6}
        roughness={0.2}
        clearcoat={1.0}
        clearcoatRoughness={0.1}
        emissive={isSpeaking ? "#047857" : "#000000"}
        emissiveIntensity={isSpeaking ? 0.5 : 0}
      />
    </mesh>
  );
}

// --- GŁÓWNA APLIKACJA ---
export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [assistantText, setAssistantText] = useState('Dzień dobry! Kliknij mikrofon lub włącz tryb ciągły, aby porozmawiać.');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState('Gotowy do rozmowy');
  const [textInput, setTextInput] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const [isHandsFree, setIsHandsFree] = useState(false);
  const isHandsFreeRef = useRef(isHandsFree);

  useEffect(() => {
    isHandsFreeRef.current = isHandsFree;
  }, [isHandsFree]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micAnimationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);

  const cleanupMicContext = () => {
    if (micAnimationFrameRef.current) {
      cancelAnimationFrame(micAnimationFrameRef.current);
      micAnimationFrameRef.current = null;
    }
    if (micAudioContextRef.current && micAudioContextRef.current.state !== 'closed') {
      micAudioContextRef.current.close().catch(console.error);
      micAudioContextRef.current = null;
    }
  };

  useEffect(() => {
    return () => cleanupMicContext();
  }, []);

  const handleAudioEnded = () => {
    setIsSpeaking(false);
    if (isHandsFreeRef.current) {
      setStatus('Słucham Cię ponownie...');
      setTimeout(() => {
        if (isHandsFreeRef.current) startRecording();
      }, 400);
    } else {
      setStatus('Dotknij mikrofonu, aby odpowiedzieć');
    }
  };

  const playBackendTTS = async (text: string) => {
    if (!text.trim()) return;
    try {
      setStatus('Marek przygotowuje odpowiedź...');

      const response = await fetch('http://127.0.0.1:8000/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) throw new Error(`Błąd HTTP ${response.status}`);

      const audioBlob = await response.blob();
      const newUrl = URL.createObjectURL(audioBlob);
      setAudioUrl(newUrl);

      setTimeout(async () => {
        if (audioPlayerRef.current) {
          try {
            audioPlayerRef.current.currentTime = 0;
            await audioPlayerRef.current.play();
          } catch (playErr) {
            console.warn('Autoodtwarzanie zablokowane', playErr);
            setStatus('Kliknij Play na odtwarzaczu, aby odsłuchać');
          }
        }
      }, 100);
    } catch (err: any) {
      console.error('Błąd TTS:', err);
      setIsSpeaking(false);
      setStatus(`Błąd głosu: ${err.message}`);
    }
  };

  const startRecording = async () => {
    try {
      if (audioPlayerRef.current) audioPlayerRef.current.pause();
      setIsSpeaking(false);
      cleanupMicContext();

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await sendAudioToBackend(audioBlob);
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
      setStatus('Brak dostępu do mikrofonu');
      setIsHandsFree(false);
    }
  };

  const stopRecording = () => {
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

      await playBackendTTS(fullText);
    } catch (err: any) {
      setAssistantText(`Wystąpił problem: ${err.message}`);
      setStatus('Błąd połączenia');
    }
  };

  const toggleHandsFree = () => {
    const nextState = !isHandsFree;
    setIsHandsFree(nextState);
    if (nextState && !isRecording && !isSpeaking && !isLoading) {
      startRecording();
    } else if (!nextState && isRecording) {
      stopRecording();
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

        <button
          onClick={toggleHandsFree}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
            isHandsFree ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 shadow-lg shadow-emerald-900/40' : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
          }`}
        >
          <Radio className={`w-3.5 h-3.5 ${isHandsFree ? 'animate-pulse text-emerald-400' : ''}`} />
          <span>{isHandsFree ? 'Tryb ciągły: WŁ' : 'Tryb ciągły: WYŁ'}</span>
        </button>
      </header>

      <section className="w-full max-w-lg my-auto py-6">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl space-y-6">
          
          {/* ================= AWATAR 3D ================= */}
          <div className="w-full h-72 bg-slate-950 rounded-3xl overflow-hidden relative shadow-inner">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-slate-500 animate-pulse text-sm">Inicjalizacja środowiska 3D...</div>}>
              <Canvas 
                camera={{ position: [0, 0, 5], fov: 45 }}
                gl={{ powerPreference: 'high-performance', antialias: true }}
              >
                <ambientLight intensity={2.5} />
                <pointLight position={[5, 5, 5]} intensity={2.0} color={isSpeaking ? "#34d399" : "#ffffff"} />
                <pointLight position={[-5, -5, -5]} intensity={1.5} />
                <ProceduralAssistant audioPlayerRef={audioPlayerRef} isSpeaking={isSpeaking} />
              </Canvas>
            </Suspense>
          </div>
          {/* ============================================== */}

          <div className="flex items-center justify-center gap-2 text-slate-400 text-sm font-medium border-t border-slate-800/80 pt-4">
            <Volume2 className={`w-5 h-5 ${isSpeaking ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
            <span>Marek:</span>
          </div>

          <p className="text-xl leading-relaxed text-slate-50 min-h-[80px] text-center italic">
            {assistantText}
          </p>

          {audioUrl && (
            <div className="pt-2">
              <audio
                ref={audioPlayerRef}
                src={audioUrl}
                crossOrigin="anonymous"
                controls
                className="w-full h-10 rounded-lg accent-emerald-500 hidden" // Odtwarzacz ukryty
                onPlay={() => setIsSpeaking(true)}
                onEnded={handleAudioEnded}
                onError={() => {
                  setIsSpeaking(false);
                  setStatus('Błąd odtwarzacza');
                }}
              />
            </div>
          )}
        </div>
      </section>

      <footer className="w-full max-w-lg flex flex-col items-center pb-6 gap-4">
        <form onSubmit={handleFormSubmit} className="w-full flex gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Wpisz wiadomość..."
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
            isRecording ? 'bg-rose-600 ring-8 ring-rose-500/30 scale-105 animate-pulse' : 'bg-emerald-500 hover:bg-emerald-400 active:scale-95'
          } ${isLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {isLoading ? <Loader2 className="w-12 h-12 text-white animate-spin" /> : isRecording ? <Square className="w-10 h-10 text-white fill-white" /> : <Mic className="w-12 h-12 text-white" />}
        </button>

        <p className="text-sm font-medium text-slate-400">{status}</p>
      </footer>
    </main>
  );
}