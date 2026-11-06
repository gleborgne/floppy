"""Faux serveur MCP « work_tools » pour le prototype n°3 (modèles locaux dans Hermes).

Simule les outils v1 de Floppy : agenda, mails, Azure DevOps, notes Obsidian, Orca.
Données fixes en mémoire. Aucun accès réseau, aucun effet de bord :
`ouvrir_url` et `orca_confier_tache` ne font qu'enregistrer la demande.
Chaque appel est ajouté au journal JSONL désigné par WORK_TOOLS_LOG (lu par eval.py).
"""
from __future__ import annotations

import json
import os
import time
import unicodedata
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

LOG = Path(os.environ.get("WORK_TOOLS_LOG", Path(__file__).resolve().parent / "calls.jsonl"))
TODAY = "2026-11-04"
TOMORROW = "2026-11-05"

mcp = FastMCP("work_tools")
RO = ToolAnnotations(readOnlyHint=True)


def _log(tool: str, **args) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": time.time(), "tool": tool, "args": args}, ensure_ascii=False) + "\n")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


# ---------------------------------------------------------------- agenda et mails
AGENDA = {
    TODAY: [
        "09:30-09:45 Daily de l'équipe Ariane (Teams)",
        "11:00-12:00 Revue d'architecture avec Sophie Martin (salle Everest)",
        "14:00-14:30 Point client avec Claire Dubois (Hexa)",
        "16:30-17:00 Dentiste (Dr Lemoine)",
    ],
    TOMORROW: [
        "10:00-12:00 Atelier UX avec l'équipe produit",
        "15:00-15:30 Entretien annuel avec Paul (RH)",
    ],
}


def _date(d: str | None) -> str:
    n = _norm(d or "")
    if not n or "aujourd" in n or n in ("today", "ce jour"):
        return TODAY
    if "demain" in n or "tomorrow" in n:
        return TOMORROW
    for key in AGENDA:
        y, m, dd = key.split("-")
        if key in n or f"{dd}/{m}" in n or n.startswith(f"{int(dd)} nov"):
            return key
    return d or TODAY


@mcp.tool(annotations=RO)
def agenda_du_jour(date: str | None = None) -> str:
    """Donne les rendez-vous de l'agenda (Outlook) pour une date. date : AAAA-MM-JJ, ou vide pour aujourd'hui."""
    _log("agenda_du_jour", date=date)
    key = _date(date)
    items = AGENDA.get(key, [])
    return f"Agenda du {key} :\n" + ("\n".join(items) if items else "(aucun rendez-vous)")


@mcp.tool(annotations=RO)
def prochain_rdv() -> str:
    """Donne le prochain rendez-vous de l'agenda (à partir de maintenant)."""
    _log("prochain_rdv")
    return f"Prochain rendez-vous ({TODAY}) : 11:00-12:00 Revue d'architecture avec Sophie Martin (salle Everest)"


MAILS = [
    ("Sophie Martin", "Ordre du jour de la revue d'architecture"),
    ("Azure DevOps", "Build master échoué (ariane)"),
    ("Marc Petit", "Facture d'octobre à valider"),
    ("Service RH", "Entretien annuel : confirmez votre créneau"),
]


@mcp.tool(annotations=RO)
def mails_non_lus(max: int = 10) -> str:
    """Liste les mails non lus (expéditeur et sujet seulement). max : nombre maximum de mails."""
    _log("mails_non_lus", max=max)
    sel = MAILS[: max or 10]
    return f"{len(MAILS)} mails non lus :\n" + "\n".join(f"- {s} : {o}" for s, o in sel)


# ---------------------------------------------------------------- Azure DevOps
@mcp.tool(annotations=RO)
def mes_pr_a_relire() -> str:
    """Liste les pull requests Azure DevOps où je suis relecteur et qui attendent ma relecture."""
    _log("mes_pr_a_relire")
    return ("2 PR à relire :\n"
            "- PR 482 (ariane-api) « Ajout du cache Redis sur l'API catalogue », par Julien Roux, ouverte hier\n"
            "- PR 479 (ariane-front) « Migration vers Vite 6 », par Emma Leroy, ouverte il y a 3 jours")


PIPELINES = {
    "master": "Pipeline master (ariane) : ÉCHOUÉ ce matin à 08:42, étape « tests e2e » (test login_safari en échec). Commit 3f9a1c2 de Julien Roux.",
    "develop": "Pipeline develop (ariane) : RÉUSSI à 10:05, tous les tests passent.",
    "nightly": "Pipeline nightly (ariane) : RÉUSSI cette nuit à 02:10.",
}


@mcp.tool(annotations=RO)
def etat_build(pipeline: str) -> str:
    """Donne l'état du dernier build d'un pipeline Azure DevOps. pipeline : nom du pipeline ou de la branche (ex. master, develop, nightly)."""
    _log("etat_build", pipeline=pipeline)
    n = _norm(pipeline)
    for k, v in PIPELINES.items():
        if k in n or (k == "master" and "main" in n):
            return v
    return f"Pipeline « {pipeline} » inconnu. Pipelines disponibles : {', '.join(PIPELINES)}."


TICKETS = [
    ("1201", "Bug de connexion (login) sur Safari", "en cours"),
    ("1187", "Export CSV des participants", "à faire"),
    ("1210", "Mettre à jour la documentation de l'API", "à faire"),
    ("1150", "Corriger l'affichage des dates", "terminé"),
]


@mcp.tool(annotations=RO)
def mes_tickets(etat: str | None = None) -> str:
    """Liste mes tickets Azure DevOps (work items). etat : « à faire », « en cours » ou « terminé » ; vide = tous sauf terminés."""
    _log("mes_tickets", etat=etat)
    n = _norm(etat or "")
    if not n:
        sel = [t for t in TICKETS if t[2] != "terminé"]
    else:
        sel = [t for t in TICKETS if _norm(t[2]) in n or n in _norm(t[2])]
    if not sel:
        return f"Aucun ticket à l'état « {etat} »."
    return "\n".join(f"- #{i} {titre} ({e})" for i, titre, e in sel)


# ---------------------------------------------------------------- notes Obsidian
VAULT = {
    "Projets/Ariane/Déploiement du front.md":
        "# Déploiement du front Ariane\n"
        "1. Depuis la branche master : `npm run build`.\n"
        "2. Envoyer le dossier dist avec `az storage blob upload-batch` vers le compte de stockage arianefrontprod.\n"
        "3. Purger le CDN : `az cdn endpoint purge` sur l'endpoint ariane-front.\n"
        "Ne jamais déployer le vendredi après 16 h.",
    "Projets/Ariane/Architecture.md":
        "# Architecture d'Ariane\n"
        "Front en React (Vite). API en .NET 9 sur Azure App Service. Base PostgreSQL 17. "
        "Cache Redis prévu (PR 482). Authentification par Entra ID.",
    "Veille/Turn detectors.md":
        "# Veille : turn detectors\n"
        "Très bon article sur la détection de fin de tour (turn detectors) pour les assistants vocaux : "
        "https://veille.example.com/voix/turn-detectors-2026\n"
        "À comparer avec le VAD Silero.",
    "Veille/Synthèse vocale.md":
        "# Veille : TTS\nComparatif Kokoro, Qwen3-TTS : https://veille.example.com/voix/tts-comparatif",
    "Réunions/2026-11-03 Rétro.md":
        "# Rétro du 3 novembre\nÀ améliorer : les tests e2e sont trop lents. Action : paralléliser (Emma).",
    "Perso/Crêpes.md":
        "# Crêpes\n250 g de farine, 4 œufs, 50 cl de lait, une pincée de sel.",
}


@mcp.tool(annotations=RO)
def chercher_notes(requete: str) -> str:
    """Cherche dans mes notes Obsidian (mots-clés). Renvoie les chemins des notes trouvées et un extrait."""
    _log("chercher_notes", requete=requete)
    words = [w for w in _norm(requete).replace("'", " ").split() if len(w) > 2]
    scored = []
    for path, text in VAULT.items():
        hay = _norm(path + " " + text)
        s = sum(1 for w in words if w in hay or (w.endswith("s") and w[:-1] in hay))
        if s:
            scored.append((s, path, text))
    scored.sort(key=lambda x: -x[0])
    if not scored:
        return "Aucune note trouvée."
    return "\n".join(f"- {p} : {t.splitlines()[1][:220] if len(t.splitlines()) > 1 else ''}" for _, p, t in scored[:3])


@mcp.tool(annotations=RO)
def lire_note(chemin: str) -> str:
    """Lit le contenu complet d'une note Obsidian. chemin : chemin renvoyé par chercher_notes."""
    _log("lire_note", chemin=chemin)
    n = _norm(chemin).removesuffix(".md")
    for path, text in VAULT.items():
        if _norm(path).removesuffix(".md") == n or _norm(path).removesuffix(".md").endswith(n):
            return text
    return f"Note « {chemin} » introuvable. Utilisez chercher_notes."


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False))
def ouvrir_url(url: str) -> str:
    """Ouvre une adresse web (URL) dans le navigateur de l'utilisateur."""
    _log("ouvrir_url", url=url)
    return f"URL ouverte dans le navigateur : {url}"


# ---------------------------------------------------------------- Orca
@mcp.tool(annotations=RO)
def orca_etat_agents() -> str:
    """Donne l'état des agents de code (Claude Code, Codex) lancés via Orca."""
    _log("orca_etat_agents")
    return ("3 agents :\n"
            "- claude-ariane-1 (ariane) : en cours, refactorisation du module paiement, ~70 %\n"
            "- codex-docs (ariane) : terminé, documentation de l'API, attend votre relecture\n"
            "- claude-hexa (hexa) : bloqué, attend votre accord pour lancer les migrations")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False))
def orca_confier_tache(projet: str, tache: str) -> str:
    """Confie une tâche de code à un agent Orca (Claude Code) dans un projet. projet : nom du projet ; tache : description de la tâche."""
    _log("orca_confier_tache", projet=projet, tache=tache)
    return f"Tâche T-57 créée dans le projet {projet} et confiée à l'agent claude-{_norm(projet)}-2 : {tache}"


if __name__ == "__main__":
    mcp.run()
