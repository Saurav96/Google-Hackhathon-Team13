// Browser speech: dictation in, a short spoken summary out. Chrome and Edge support both.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = "speechSynthesis" in window;

export function listen({ onInterim, onFinal, onEnd }) {
  const recognition = new Recognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (const result of event.results) {
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    onInterim(finalText + interim);
  };
  recognition.onerror = () => onEnd();
  recognition.onend = () => {
    if (finalText.trim()) onFinal(finalText.trim());
    onEnd();
  };
  recognition.start();
  return () => recognition.stop();
}

// Reads only the opening sentences, with tables and markdown marks removed.
export function speak(markdown) {
  if (!canSpeak) return;
  window.speechSynthesis.cancel();
  const plain = markdown
    .split("\n")
    .filter((line) => !line.trim().startsWith("|"))
    .join(" ")
    .replace(/[#*_`>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) || [plain];
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(sentences.slice(0, 3).join(" ")));
}

export const stopSpeaking = () => canSpeak && window.speechSynthesis.cancel();
