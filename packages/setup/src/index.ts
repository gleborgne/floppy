// API publique de @floppy/setup : le code produit qui prépare la machine de l'utilisateur
// (premier lancement, bibliothèques de modèles et de programmes locaux). Dépend du noyau, jamais l'inverse.
export { modelLibrary, formatBytes, entrySize, type LibraryEntry, type LibraryOptions } from "./model-library.ts";
export { programLibrary, pickBuild, findProgram, type ProgramBuild, type ProgramOptions, type ProgramLibrary, type ProgramChange, restartsModels, failoverText, programRuns } from "./program-library.ts";
export { Onboarding, onboardingFor, planChoices, installSteps, candidates, cloudBrains, offeredVoices, findAgents, ADD_PREFIX, NO_VOICE, withManualMemory, ROLE_SLOT, MIN_SPEED, MIN_LOCAL_BRAIN, type Plan, type PlanOptions, type Choice, type ChoiceRole, type Selection, type Candidate, type CloudBrain, type Agent, type Role, type OnboardingDeps, type OnboardingState, type OnboardingRow, type OnboardingFile } from "./onboarding.ts";
export { HOME_MIGRATIONS, migrateHome } from "./home-migrations.ts";
