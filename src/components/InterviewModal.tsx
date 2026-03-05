import React, { useState, useEffect, useRef } from "react";
import { useInterviewAudio } from "../hooks/useInterviewAudio";

interface InterviewModalProps {
  onClose: () => void;
  onSubmit: (transcript: string) => void;
}

export const InterviewModal: React.FC<InterviewModalProps> = ({ onClose, onSubmit }) => {
  const { messages, isRecording, logs, isModelReady, startInterview, stopInterview } = useInterviewAudio();
  const [showLogs, setShowLogs] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle manual submit
  const handleSubmit = () => {
    stopInterview();
    // Combine all messages into a single transcript block
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto"
      onMouseEnter={() => window.ghostly.enableMouse()}
      onMouseLeave={() => window.ghostly.disableMouse()}
    >
      <div className="bg-[rgba(20,20,23,0.95)] border border-white/[0.12] w-[800px] h-[600px] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08] bg-black/20">
          <div className="flex items-center gap-3">
            <span className="text-xl">👻</span>
            <div>
              <h2 className="text-white/90 font-semibold text-sm font-sans">Live Interview Copilot</h2>
              <p className="text-white/40 text-[11px]">System Audio (Left) • Mic Audio (Right)</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setShowLogs(!showLogs)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-xs transition-colors"
            >
              {showLogs ? "Hide Logs" : "Show Logs"}
            </button>
            <button 
              onClick={handleClose}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-white/[0.05] hover:bg-red-500/20 hover:text-red-400 text-white/60 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Chat Interface */}
          <div className={`flex flex-col h-full transition-all duration-300 ${showLogs ? 'w-[60%]' : 'w-full'} border-r border-white/[0.08]`}>
            
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-white/30 text-sm space-y-2">
                  <p>No audio captured yet.</p>
                  <p className="text-xs text-white/20">Click Start below when you're ready.</p>
                </div>
              )}
              
              {messages.map((msg) => (
                <div 
                  key={msg.id} 
                  className={`flex w-full ${msg.source === 'mic' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[80%] rounded-2xl px-4 py-3 flex flex-col ${
                    msg.source === 'mic' 
                      ? 'bg-blue-500/20 text-blue-100 border border-blue-500/30 rounded-br-sm' 
                      : 'bg-white/[0.05] text-white/80 border border-white/[0.08] rounded-bl-sm'
                  }`}>
                    <div className="text-[10px] opacity-50 mb-1 font-sans">
                      {msg.source === 'mic' ? 'You' : 'Interviewer'}
                    </div>
                    <div className="text-sm leading-relaxed">
                      {msg.text}
                    </div>
                    
                    {/* Debug Audio Player */}
                    {msg.audioUrl && (
                      <audio 
                        controls 
                        src={msg.audioUrl} 
                        className="h-7 w-full max-w-[200px] mt-3 opacity-60 hover:opacity-100 transition-opacity" 
                        style={{ filter: "invert(100%)" }} // Simple hack to make native audio player look slightly better on dark backgrounds
                      />
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Controls */}
            <div className="p-4 bg-black/20 border-t border-white/[0.08] flex items-center justify-between">
              <div className="flex items-center gap-3">
                {!isRecording ? (
                  <button
                    onClick={startInterview}
                    disabled={!isModelReady}
                    className="flex items-center gap-2 px-5 py-2.5 bg-green-500 hover:bg-green-400 disabled:bg-white/10 disabled:text-white/30 text-black font-semibold rounded-xl text-sm transition-all"
                  >
                    <span className="w-2 h-2 rounded-full bg-black/50" />
                    {isModelReady ? "Start Recording" : "Loading AI..."}
                  </button>
                ) : (
                  <button
                    onClick={stopInterview}
                    className="flex items-center gap-2 px-5 py-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 font-semibold rounded-xl text-sm transition-all"
                  >
                    <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                    Stop Recording
                  </button>
                )}
              </div>
              
              <button
                onClick={handleSubmit}
                disabled={messages.length === 0}
                className="px-5 py-2.5 bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white font-medium rounded-xl text-sm transition-colors flex items-center gap-2"
              >
                Send to Copilot 🚀
              </button>
            </div>
          </div>

          {/* Dev Logs Panel */}
          {showLogs && (
            <div className="w-[40%] bg-black/40 flex flex-col">
              <div className="px-4 py-2 border-b border-white/[0.08] text-xs text-white/50 uppercase tracking-wider font-semibold">
                Dev Logs
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[10px] text-white/60">
                {logs.map((log, i) => (
                  <div key={i} className="break-words">
                    {log}
                  </div>
                ))}
                {logs.length === 0 && <div className="italic opacity-50">Waiting for logs...</div>}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
