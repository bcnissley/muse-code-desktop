import { useEffect, useRef, useState } from "react";
import {
  createVoiceInput,
  isVoiceSupported,
  type VoiceHandle,
} from "../lib/voice";

export default function Composer({
  onSend,
  onStop,
  disabled,
  working,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
  working: boolean;
}) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const voiceSupported = useRef(isVoiceSupported());
  const voiceRef = useRef<VoiceHandle | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    voiceRef.current = createVoiceInput(
      (finalText) => setText((t) => t + finalText),
      (l) => {
        listeningRef.current = l;
        setListening(l);
      },
      () => {
        listeningRef.current = false;
        setListening(false);
      }
    );
    return () => voiceRef.current?.stop();
  }, []);

  // Global voice hotkey (F9): toggle dictation on/off.
  useEffect(() => {
    const onToggle = () => {
      if (!voiceRef.current?.supported) return;
      if (listeningRef.current) voiceRef.current.stop();
      else voiceRef.current.start();
    };
    window.addEventListener("mcd:toggle-voice", onToggle);
    return () => window.removeEventListener("mcd:toggle-voice", onToggle);
  }, []);

  const doSend = () => {
    const t = text.trim();
    if (!t || disabled) return;
    voiceRef.current?.stop();
    onSend(t);
    setText("");
    taRef.current?.focus();
  };

  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  // Hold-to-talk: press-and-hold the mic; releasing stops. A quick tap
  // (under ~400ms) toggles dictation on/off instead (tap-to-dictate).
  const micDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!voiceRef.current?.supported) return;
    holdActive.current = false;
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      holdActive.current = true;
      voiceRef.current?.start(); // hold mode: talk until release
    }, 400);
  };
  const micUp = () => {
    if (holdTimer.current !== null) {
      // short tap: toggle
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
      if (listening) voiceRef.current?.stop();
      else voiceRef.current?.start();
    } else if (holdActive.current) {
      // hold released: stop dictation
      holdActive.current = false;
      voiceRef.current?.stop();
    }
  };

  return (
    <div className="composer">
      <div className="composer-row">
        <button
          className={`mic-btn ${listening ? "listening" : ""}`}
          title={
            voiceRef.current?.supported || voiceSupported.current
              ? listening
                ? "Stop dictation"
                : "Tap to dictate · hold to talk"
              : "Voice input not supported here"
          }
          disabled={!voiceSupported.current}
          onMouseDown={micDown}
          onMouseUp={micUp}
        >
          {listening ? "⏹" : "🎙"}
        </button>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyDown}
          placeholder={disabled ? "Working…" : "Message Muse Code…"}
          disabled={disabled}
          rows={2}
        />
        <button
          className={`send-btn${working ? " stop" : ""}`}
          onClick={working ? onStop : doSend}
          disabled={working ? false : disabled || !text.trim()}
          title={working ? "Stop generating" : "Send"}
        >
          {working ? "■" : "→"}
        </button>
      </div>
      <div className="composer-hint">
        {listening
          ? "Listening… speak now"
          : voiceSupported.current
            ? "Enter to send · Shift+Enter for newline"
            : "Voice input is not available in this build"}
      </div>
    </div>
  );
}
