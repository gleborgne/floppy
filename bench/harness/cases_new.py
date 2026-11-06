"""20 NOUVELLES demandes (contrôle), écrites le 4/11/2026 AVANT toute exécution. Gelées : ne pas modifier.

Même format que prototypes/local-models/eval.py (need / allow / args / keys / kind), plus :
  approval : "auto" (accord donné) ou "deny" (accord refusé) pour les écritures.
  kind "denied" : écriture refusée. Attendu : l'accord est demandé pour l'outil (avec les bons arguments),
                  le serveur MCP ne reçoit aucun appel d'écriture, la réponse dit que c'est refusé / pas fait.
Style : oral, comme une transcription (minuscules, pas de ponctuation, « flopy », hésitations, mots mal transcrits).
Aucune donnée ajoutée au faux serveur MCP : tout existe déjà dans work_mcp/server.py.
"""
CASES_NEW = [
    # --- un outil, formulations orales / indirectes
    dict(id="n_aprem", prompt="euh flopy j'ai quoi au programme cet aprem", kind="tool",
         need=["agenda_du_jour"], allow=["prochain_rdv"],
         keys=[r"hexa|dubois|claire|dentiste|lemoine"]),
    dict(id="n_dentiste", prompt="à quelle heure je dois filer chez le dentiste", kind="tool",
         need=["agenda_du_jour"], allow=["prochain_rdv"],
         keys=[r"16"]),
    dict(id="n_rh_mail", prompt="est-ce que les rh m'ont écrit", kind="tool",
         need=["mails_non_lus"],
         keys=[r"entretien|creneau"]),
    dict(id="n_pr", prompt="flopy y a des pool request qui m'attendent", kind="tool",
         need=["mes_pr_a_relire"],
         keys=[r"redis|482|vite|479"]),
    dict(id="n_nightly", prompt="la nightly elle a planté cette nuit", kind="tool",
         need=["etat_build"], args={"etat_build": {"pipeline": r"nightly"}},
         keys=[r"reussi|pas plante|n'a pas plante|passe|succes|vert|bien"]),
    dict(id="n_ci_rouge", prompt="pourquoi la ci est rouge sur master", kind="tool",
         need=["etat_build"], args={"etat_build": {"pipeline": r"master|main"}},
         keys=[r"e2e|safari|login|test"]),
    dict(id="n_tickets_finis", prompt="donne moi la liste de mes tickets terminés", kind="tool",
         need=["mes_tickets"], args={"mes_tickets": {"etat": r"termin"}},
         keys=[r"date|1150"]),
    dict(id="n_crepes", prompt="c'est quoi déjà ma recette de crêpes", kind="tool",
         need=["chercher_notes"], allow=["lire_note"], args={"chercher_notes": {"requete": r"crepe"}},
         keys=[r"farine|lait|oeuf|œuf"]),
    dict(id="n_retro", prompt="on avait décidé quoi à la rétro d'hier", kind="tool",
         need=["chercher_notes|lire_note"], allow=["chercher_notes", "lire_note"],
         keys=[r"parallel|e2e|emma"]),
    dict(id="n_agent_attend", prompt="y a un agent qui attend après moi", kind="tool",
         need=["orca_etat_agents"],
         keys=[r"hexa|migration|docs|relecture|accord"]),
    # --- écritures (porte d'accord)
    dict(id="n_ouvrir_tts", prompt="ouvre moi le comparatif des voix tts que j'avais mis de côté", kind="tool",
         approval="auto", need=["chercher_notes", "ouvrir_url"], allow=["lire_note"],
         args={"ouvrir_url": {"url": r"^https://veille\.example\.com/voix/tts-comparatif/?$"}},
         keys=[r"ouv|voila|c'est fait|navigateur"]),
    dict(id="n_orca_refuse", prompt="demande à orka d'ajouter l'export csv dans le projet ariane", kind="denied",
         approval="deny", need=["orca_confier_tache"],
         args={"orca_confier_tache": {"projet": r"ariane", "tache": r"csv|export"}},
         keys=[r"refus|annul|pas ete|n'a pas|pas confi|pas pu|pas lance|pas fait|abandon"]),
    # --- plusieurs outils
    dict(id="n_multi_pr_build", prompt="fais moi un topo rapide mes pr à relire et le build de develop", kind="tool",
         need=["mes_pr_a_relire", "etat_build"], args={"etat_build": {"pipeline": r"develop"}},
         keys=[r"redis|482|vite|479", r"reussi|vert|passe|succes"]),
    dict(id="n_multi_ticket_agent", prompt="j'ai des tickets en cours et l'agent du paiement il en est où", kind="tool",
         need=["mes_tickets", "orca_etat_agents"],
         keys=[r"safari|login|connexion|1201", r"70|paiement"]),
    dict(id="n_multi_demain_mails", prompt="flopy demain j'ai quoi et est-ce que j'ai des mails pas lus", kind="tool",
         need=["agenda_du_jour", "mails_non_lus"], args={"agenda_du_jour": {"date": r"2026-11-05|demain|05/11|5 nov"}},
         keys=[r"atelier|ux|entretien|paul", r"sophie|facture|entretien|azure|mail|quatre|\b4\b"]),
    # --- sans outil
    dict(id="n_merci", prompt="merci flopy t'es au top", kind="none", keys=[]),
    dict(id="n_rebase", prompt="en deux mots c'est quoi la différence entre un merge et un rebase", kind="none",
         keys=[r"rebase", r"merge|fusion"]),
    dict(id="n_heure", prompt="une réunion de 45 minutes qui commence à 14h20 elle finit à quelle heure", kind="none",
         keys=[r"15\s*h\s*0?5|15:05|quinze heures cinq"]),
    # --- ambiguës : une question courte attendue, aucun outil
    dict(id="n_ambigu_build", prompt="il en est où le build", kind="clarify", keys=[]),
    dict(id="n_ambigu_celui", prompt="ouvre moi celui dont je t'ai parlé", kind="clarify", keys=[]),
]
assert len(CASES_NEW) == 20 and len({c["id"] for c in CASES_NEW}) == 20
