/**
 * Voice input: Web Speech API where available.
 * Contract: tap-to-dictate and hold-to-talk both work, and unsupported
 * environments get a clear disabled state instead of a dead button.
 */
export interface VoiceHandle {
  start: () => void;
  stop: () => void;
  supported: boolean;
}

export function isVoiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    ((window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition)
  );
}

export function createVoiceInput(
  onFinalText: (text: string) => void,
  onStateChange: (listening: boolean) => void,
  onError?: (msg: string) => void
): VoiceHandle {
  const Ctor =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    return {
      start: () => {},
      stop: () => {},
      supported: false,
    };
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = "en-US";

  rec.onresult = (e: any) => {
    let finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
    }
    if (finalText.trim()) onFinalText(finalText.trim() + " ");
  };
  rec.onend = () => onStateChange(false);
  rec.onerror = (e: any) => {
    onStateChange(false);
    onError?.(e.error || "speech recognition error");
  };

  return {
    supported: true,
    start: () => {
      try {
        rec.start();
        onStateChange(true);
      } catch {
        /* already started */
      }
    },
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* not started */
      }
      onStateChange(false);
    },
  };
}
