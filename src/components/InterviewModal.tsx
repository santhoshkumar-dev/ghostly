import React, { useState, useEffect, useRef } from "react";
import { useInterviewAudio } from "../hooks/useInterviewAudio";

interface InterviewModalProps {
  onClose: () => void;
  onSubmit: (transcript: string) => void;
}

export const InterviewModal: React.FC<InterviewModalProps> = ({ onClose, onSubmit }) => {
  const { messages, isRecording, logs, debugAudios, isModelReady, startInterview, stopInterview } = useInterviewAudio();
  const [showLogs, setShowLogs] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle manual submit
  const handleSubmit = () => {
    stopInterview();
    const fullTranscript = messages
      .map(m => `${m.source === 'system' ? 'Interviewer' : 'Me'}: ${m.text}`)
      .join('\n');
    onSubmit(fullTranscript);
  };

  const handleClose = () => {
    stopInterview();
    onClose();
  };

  return (
    <div 
      className="pointer-events-auto rounded-2xl overflow-hidden flex flex-col transition-all duration-300 w-full"
      style={{
        background: "rgba(20, 20, 23, 0.75)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 10px 40px -10px rgba(0,0,0,0.5)",
      }}
      onMouseEnter={() => window.ghostly.enableMouse()}
      onMouseLeave={() => window.ghostly.disableMouse()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.05] bg-white/[0.02]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              {isRecording && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRecording ? 'bg-red-500' : 'bg-white/20'}`}></span>
            </span>
            <h2 className="text-white/90 font-semibold text-xs font-mono">Live Interview</h2>
          </div>
          <span className="text-white/30 text-[10px] font-mono hidden sm:inline">| Mic (You) & System (Interviewer)</span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setShowLogs(!showLogs)}
            className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] transition-colors"
          >
            {showLogs ? "Hide Debug" : "Debug"}
          </button>
          <button 
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 text-white/60 transition-colors text-xs"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex w-full" style={{ height: "320px" }}>
        
        {/* Chat Interface */}
        <div className={`flex flex-col h-full transition-all duration-300 ${showLogs ? 'w-[60%] border-r border-white/[0.05]' : 'w-full'}`}>
          
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-white/30 text-xs space-y-1 font-mono">
                <p>No audio captured yet.</p>
                <p className="text-[10px] text-white/20">Click Start below to begin.</p>
              </div>
            )}
            
            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`flex w-full ${msg.source === 'mic' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[85%] rounded-xl px-3 py-2 flex flex-col ${
                  msg.source === 'mic' 
                    ? 'bg-blue-500/10 text-blue-100 border border-blue-500/20 rounded-br-sm' 
                    : 'bg-white/[0.03] text-white/80 border border-white/[0.05] rounded-bl-sm'
                }`}>
                  <div className="text-[9px] opacity-50 mb-0.5 font-sans uppercase tracking-wider">
                    {msg.source === 'mic' ? 'You' : 'Interviewer'}
                  </div>
                  <div className="text-xs leading-relaxed">
                    {msg.text}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Controls */}
          <div className="p-3 bg-black/20 border-t border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center gap-2">
              {!isRecording ? (
                <button
                  onClick={startInterview}
                  disabled={!isModelReady}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/90 hover:bg-green-400 disabled:bg-white/10 disabled:text-white/30 text-black font-semibold rounded text-xs transition-all"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-black/50" />
                  {isModelReady ? "Start" : "Loading..."}
                </button>
              ) : (
                <button
                  onClick={stopInterview}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 font-semibold rounded text-xs transition-all"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                  Stop
                </button>
              )}
            </div>
            
            <button
              onClick={handleSubmit}
              disabled={messages.length === 0}
              className="px-4 py-1.5 bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white font-medium rounded text-xs transition-colors flex items-center gap-1.5"
            >
              Ask Copilot 🚀
            </button>
          </div>
        </div>

        {/* Dev Logs Panel */}
        {showLogs && (
          <div className="w-[40%] bg-black/40 flex flex-col">
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              
              {/* Audio Debugger */}
              {debugAudios.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold">Raw Audio:</div>
                  {debugAudios.map((da, i) => (
                    <div key={i} className="bg-white/[0.02] p-1.5 rounded border border-white/[0.05]">
                      <div className="text-[9px] text-white/60 mb-1">{da.name}</div>
                      <audio controls src={da.url} className="h-5 w-full" style={{ filter: "invert(100%)" }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Text Logs */}
              <div className="space-y-0.5 font-mono text-[9px] text-white/50">
                <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold mb-1.5 mt-3">Logs:</div>
                {logs.map((log, i) => (
                  <div key={i} className={`break-words ${log.includes('WARNING') ? 'text-yellow-400' : ''}`}>
                    {log}
                  </div>
                ))}
                {logs.length === 0 && <div className="italic opacity-30">Waiting for logs...</div>}
              </div>

            </div>
          </div>
        )}

      </div>
    </div>
  );
};
