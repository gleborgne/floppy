// Liste des plugins connus. Une entrée de la config choisit un plugin par son id (champ `plugin:`).
import type { PluginDef } from "@floppy/core";
import tools from "@floppy/plugin-tools";
import llmLlamacpp from "@floppy/plugin-llm-llamacpp";
import llmOpenai from "@floppy/plugin-llm-openai";
import memory from "@floppy/plugin-memory";
import brainAisdk from "@floppy/plugin-brain-aisdk";
import benchApi from "@floppy/plugin-bench-api";
import brainClaudeCli from "@floppy/plugin-brain-claude-cli";
import brainCodexCli from "@floppy/plugin-brain-codex-cli";
import brainAgyCli from "@floppy/plugin-brain-agy-cli";
import bodyHub from "@floppy/plugin-body-hub";
import bodyWs from "@floppy/plugin-body-ws";
import bodyElectron from "@floppy/plugin-body-electron";
import bodyReachy from "@floppy/plugin-body-reachy";
import conversation from "@floppy/plugin-conversation";
import orca from "@floppy/plugin-orca";
import browser from "@floppy/plugin-browser";
import inbox from "@floppy/plugin-inbox";
import websearch from "@floppy/plugin-websearch";
import m365 from "@floppy/plugin-m365";
import avatarTv from "@floppy/plugin-avatar-tv";
import avatarPixel from "@floppy/plugin-avatar-pixel";
import avatarEssaim from "@floppy/plugin-avatar-essaim";
import avatarGyre from "@floppy/plugin-avatar-gyre";
import avatarGoutte from "@floppy/plugin-avatar-goutte";
import avatarOscillo from "@floppy/plugin-avatar-oscillo";
import avatarIris from "@floppy/plugin-avatar-iris";
import avatarPixelcat from "@floppy/plugin-avatar-pixelcat";
import coder from "@floppy/plugin-coder";
import agentSessions from "@floppy/plugin-agent-sessions";
import ttsGemini from "@floppy/plugin-tts-gemini";
import ttsElevenlabs from "@floppy/plugin-tts-elevenlabs";
import liveGemini from "@floppy/plugin-live-gemini";
import liveOpenai from "@floppy/plugin-live-openai";
import wakewordSherpa from "@floppy/plugin-wakeword-sherpa";
import wakewordPorcupine from "@floppy/plugin-wakeword-porcupine";
import wakewordStt from "@floppy/plugin-wakeword-stt";
import searxng from "@floppy/plugin-searxng";
import documents from "@floppy/plugin-documents";
import scheduler from "@floppy/plugin-scheduler";
import veille from "@floppy/plugin-veille";
import notifyTelegram from "@floppy/plugin-notify-telegram";
import notifyMail from "@floppy/plugin-notify-mail";
import ttsAudiocpp from "@floppy/plugin-tts-audiocpp";
import ttsSystem from "@floppy/plugin-tts-system";
import voiceListen from "@floppy/plugin-voice-listen";
import sttSherpa from "@floppy/plugin-stt-sherpa";

export const catalog: PluginDef<any>[] = [
  tools, llmLlamacpp, llmOpenai, memory, brainAisdk, brainClaudeCli, brainCodexCli, brainAgyCli,
  bodyHub, bodyWs, bodyElectron, bodyReachy, conversation, orca, browser, inbox, websearch, m365, avatarTv, avatarPixel, avatarEssaim, avatarGyre, avatarGoutte, avatarOscillo, avatarIris, avatarPixelcat, coder, agentSessions,
  ttsGemini, ttsElevenlabs, liveGemini, liveOpenai,
  wakewordStt, wakewordSherpa, wakewordPorcupine,
  searxng, documents, scheduler, veille, notifyTelegram, notifyMail, ttsAudiocpp, ttsSystem, voiceListen, sttSherpa,
];

/**
 * Plugins de développement, chargés seulement avec FLOPPY_DEV=1. `bench-api` répond aux accords tout seul pour le banc
 * (en-tête X-Approval) : il ne doit jamais tourner dans un Floppy de tous les jours.
 */
export const devPlugins: PluginDef<any>[] = [benchApi];
if (process.env.FLOPPY_DEV === "1") catalog.push(...devPlugins);
