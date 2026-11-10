// Types partagés du processus principal (aucun code : uniquement des types, effacés au lancement).
import type { Bilingual } from "./placement.ts";

/**
 * Message du noyau (utilityProcess) ou demande d'une page : les champs dépendent de `type` et ne sont pas vérifiés
 * à l'exécution (chaque branche valide ce qu'elle lit). `any` assumé : ce protocole n'a pas de type partagé.
 */
export interface Msg { type?: string; [key: string]: any }
/** Texte simple, ou { fr, en } venu du noyau. */
export type Say = string | Bilingual;
/** Résolution de la réponse du noyau à une demande (la forme dépend de la demande). */
export type Reply = (r: any) => void;
export interface Display { avatar_visible: boolean; masquer_apres: number; bulle: boolean; toujours_devant: boolean; avatar: string; avatarUrl: string; raccourcis?: Record<string, string>; demarrage_windows?: boolean; [key: string]: unknown }
