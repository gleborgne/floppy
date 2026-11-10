// Anciens noms (français) des outils que Floppy définit lui-même, par TYPE de plugin qui les définit.
// Sert aux étapes de migration du dossier de travail (voir `home-migrations.ts`) : un nom n'est renommé que s'il est
// sous le type de plugin qui le définit. Les outils d'un serveur MCP extérieur (type `tools`, noms choisis par le
// serveur : `agenda_du_jour`, `ouvrir_url` d'un serveur à soi…) n'ont jamais d'entrée ici, donc ne sont jamais touchés.
// Les noms d'outils du noyau ont pour source « core » ; ceux de la CLI ont leur source fixe (`plugin-store`…).

export const TOOL_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: {
    lister_reglages: "list_settings", changer_reglage: "change_setting", annuler_reglage: "undo_setting",
    lister_elements: "list_items", activer_element: "toggle_item", utiliser_element: "use_item", ajouter_application: "add_app",
    taches: "list_tasks", lancer_tache: "run_task",
  },
  "plugin-store": { installer_plugin: "install_plugin", plugins_tiers: "list_third_party_plugins", desinstaller_plugin: "uninstall_plugin" },
  "plugins-wiki": { doc_plugins: "plugin_docs" },
  "user-plugins": { etat_plugins: "plugin_status", recharger_plugins: "reload_plugins", tester_plugin: "test_plugin" },
  "body-electron": { ouvrir_reglages: "open_settings" },
  // Outils des corps d'origine Floppy (avatar, Reachy), enregistrés par l'entrée du hub. `regarder`, `content` et `danser`
  // (Reachy) sont des mots courants, un corps extérieur peut les porter : ils ne sont pas renommés ici (outils en lecture, jamais gardés).
  "body-hub": { afficher_carte: "show_card", placer_avatar: "place_avatar", hocher_tete: "nod_head", secouer_tete: "shake_head" },
  "agent-jobs": {
    lister_agents: "list_agents", deleguer_agent: "delegate_to_agent", lancer_travail_agent: "start_agent_job",
    travaux_agents: "list_agent_jobs", arreter_travail_agent: "stop_agent_job",
  },
  "agent-sessions": { ouvrir_session_agent: "open_agent_session" },
  documents: { afficher_document: "show_document", ouvrir_document: "open_document", lister_documents: "list_documents" },
  memory: { memoriser: "remember", chercher_historique: "search_history" },
  scheduler: { envoyer: "send_document" },
  browser: { ouvrir_url: "open_url" },
  inbox: { annonces_recentes: "list_recent_announcements", ouvrir_annonce: "open_announcement" },
  websearch: { chercher_web: "search_web" },
  searxng: { chercher_searxng: "search_searxng" },
  orca: {
    orca_envoyer: "orca_send", orca_envoyer_groupe: "orca_send_group", orca_envois: "orca_deliveries",
    orca_annuler_envoi: "orca_cancel_delivery", orca_historique: "orca_history", orca_ecran: "orca_screen", orca_recherche: "orca_search",
  },
  m365: {
    m365_mails_non_lus: "m365_unread_mail", m365_chercher_mails: "m365_search_mail", m365_lire_fil_mail: "m365_read_mail_thread",
    m365_lire_mail: "m365_read_mail", m365_agenda: "m365_calendar", m365_prochain_rdv: "m365_next_meeting",
    m365_creneaux_libres: "m365_free_slots", m365_chercher_personnes: "m365_search_people", m365_chercher_fichiers: "m365_search_files",
    m365_ajouter_rdv: "m365_add_meeting", m365_ajouter_rappel: "m365_add_reminder", m365_conversations_teams: "m365_teams_chats",
    m365_messages_teams: "m365_teams_messages", m365_teams_non_lus: "m365_teams_unread", m365_lire_conversation_teams: "m365_read_teams_chat",
    m365_canaux_teams: "m365_teams_channels", m365_messages_canal: "m365_channel_messages",
    m365_envoyer_message_teams: "m365_send_teams_message", m365_publier_canal: "m365_post_channel",
  },
  veille: { veille_avis: "watch_feedback", veille_interets: "watch_interests", veille_article: "watch_article", veille_modifier_interet: "watch_edit_interest" },
  vocabulary: { lister_corrections: "list_corrections", corriger_vocabulaire: "correct_vocabulary", oublier_correction: "forget_correction" },
};

/** Sources fixes (pas des entrées de floppy.yml) : leur nom est aussi leur « type ». */
export const FIXED_SOURCES: readonly string[] = ["core", "plugin-store", "plugins-wiki", "user-plugins"];
