-- Cas d'usage « Transcription » : les modèles qui transcrivent l'audio (Voxtral Small, Gemini), placé après « Traduction ».
ALTER TYPE "UseCase" ADD VALUE 'TRANSCRIPTION' AFTER 'TRANSLATION';
