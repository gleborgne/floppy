// Filet de sécurité de la normalisation de texte : ce que chaque petite fonction « accents / casse / ponctuation »
// répartie dans le noyau et les plugins renvoyait AVANT leur remplacement par les fonctions partagées (text.ts).
// LEGACY reprend mot pour mot les expressions d'origine ; GOLDEN fige leurs sorties sur des entrées piégeuses
// (accents, ligatures, apostrophes ' ’ ‘, tirets, chiffres, espaces insécables, émoji, contractions anglaises…).
import { describe, expect, it } from "vitest";
import { fold, foldTokens, normWord, slugify, stripAccents, wordsKey } from "../src/index.ts";

const INPUTS: string[] = [""," ","\u00c9t\u00e9","\u00c9T\u00c9","c\u0153ur","\u0152uvre \u0152UF","l'\u00e9t\u00e9","l\u2019\u00e9t\u00e9","l\u2018\u00e9t\u00e9","don`t","don't","it's","I\u2019m sure","well-known","peut-\u00eatre","abc123","  deux   espaces  ","a\u00a0b","tab\tnew\nline","Hello, World!","\u00c7a va ?","\ud83d\ude42 ok","na\u00efve caf\u00e9","stra\u00dfe \u1e9e","\u0130stanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03a3\u03af\u03c3\u03c5\u03c6\u03bf\u03c2 \u0391\u03a3","x\u0301 combining","!!!","Sure!","Rien n\u2019est attendu de vous.","Ouvre les r\u00e9glages de Floppy, s\u2019il te pla\u00eet ?","  Tr\u00e8s surpris+ ","un peu triste"," joie- ","[Joie]","\u00c7a fait 3 000 \u20ac \u2014 voil\u00e0\u2026","Projet Diff\u00e9rendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \u00e9","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","I'd like it, please. Don\u2019t stop."];

const LEGACY: Record<string, (s: string) => unknown> = {
  fold: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
  foldTrim: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(),
  trimFold: (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""),
  foldApos: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, " "),
  foldCurly: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’]/g, "'").trim(),
  claim: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trimStart(),
  foldSpaces: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(),
  wordsKey: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(),
  echoWords: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean),
  veilleWords: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w: string) => w.length >= 2),
  compact: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""),
  normWord: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, ""),
  tokens: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? [],
  slugDocs: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, ""),
  slugSessions: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-"),
  slugMcp: (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "commande",
  annSentence: (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’‘]/g, "'").toLowerCase().replace(/[.!?]+$/, "").trim(),
  stripThenLower: (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
  m365: (s: string) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase(),
};

const GOLDEN: Record<string, unknown[]> = {
  fold: [""," ","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l\u2019ete","l\u2018ete","don`t","don't","it's","i\u2019m sure","well-known","peut-etre","abc123","  deux   espaces  ","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n\u2019est attendu de vous.","ouvre les reglages de floppy, s\u2019il te plait ?","  tres surpris+ ","un peu triste"," joie- ","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don\u2019t stop."],
  foldTrim: ["","","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l\u2019ete","l\u2018ete","don`t","don't","it's","i\u2019m sure","well-known","peut-etre","abc123","deux   espaces","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n\u2019est attendu de vous.","ouvre les reglages de floppy, s\u2019il te plait ?","tres surpris+","un peu triste","joie-","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don\u2019t stop."],
  trimFold: ["","","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l\u2019ete","l\u2018ete","don`t","don't","it's","i\u2019m sure","well-known","peut-etre","abc123","deux   espaces","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n\u2019est attendu de vous.","ouvre les reglages de floppy, s\u2019il te plait ?","tres surpris+","un peu triste","joie-","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don\u2019t stop."],
  foldApos: [""," ","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l ete","l ete","l\u2018ete","don`t","don t","it s","i m sure","well-known","peut-etre","abc123","  deux   espaces  ","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n est attendu de vous.","ouvre les reglages de floppy, s il te plait ?","  tres surpris+ ","un peu triste"," joie- ","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i d like it, please. don t stop."],
  foldCurly: ["","","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l'ete","l\u2018ete","don`t","don't","it's","i'm sure","well-known","peut-etre","abc123","deux   espaces","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n'est attendu de vous.","ouvre les reglages de floppy, s'il te plait ?","tres surpris+","un peu triste","joie-","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don't stop."],
  claim: ["","","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l'ete","l\u2018ete","don't","don't","it's","i'm sure","well-known","peut-etre","abc123","deux espaces ","a b","tab new line","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b'c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n'est attendu de vous.","ouvre les reglages de floppy, s'il te plait ?","tres surpris+ ","un peu triste","joie- ","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don't stop."],
  foldSpaces: ["","","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l\u2019ete","l\u2018ete","don`t","don't","it's","i\u2019m sure","well-known","peut-etre","abc123","deux espaces","a b","tab new line","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n\u2019est attendu de vous.","ouvre les reglages de floppy, s\u2019il te plait ?","tres surpris+","un peu triste","joie-","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don\u2019t stop."],
  wordsKey: ["","","ete","ete","c ur","uvre uf","l ete","l ete","l ete","don t","don t","it s","i m sure","well known","peut etre","abc123","deux espaces","a b","tab new line","hello world","ca va","ok","naive cafe","stra e","istanbul","ligature","a b c d e","","x combining","","sure","rien n est attendu de vous","ouvre les reglages de floppy s il te plait","tres surpris","un peu triste","joie","joie","ca fait 3 000 voila","projet differendum env stg 2","a b c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","tiret","i d like it please don t stop"],
  echoWords: [[],[],["ete"],["ete"],["c","ur"],["uvre","uf"],["l","ete"],["l","ete"],["l","ete"],["don","t"],["don","t"],["it","s"],["i","m","sure"],["well","known"],["peut","etre"],["abc123"],["deux","espaces"],["a","b"],["tab","new","line"],["hello","world"],["ca","va"],["ok"],["naive","cafe"],["stra","e"],["istanbul"],["ligature"],["a","b","c","d","e"],[],["x","combining"],[],["sure"],["rien","n","est","attendu","de","vous"],["ouvre","les","reglages","de","floppy","s","il","te","plait"],["tres","surpris"],["un","peu","triste"],["joie"],["joie"],["ca","fait","3","000","voila"],["projet","differendum","env","stg","2"],["a","b","c","d"],["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","e"],["un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix"],["tiret"],["i","d","like","it","please","don","t","stop"]],
  veilleWords: [[],[],["ete"],["ete"],["ur"],["uvre","uf"],["ete"],["ete"],["ete"],["don"],["don"],["it"],["sure"],["well","known"],["peut","etre"],["abc123"],["deux","espaces"],[],["tab","new","line"],["hello","world"],["ca","va"],["ok"],["naive","cafe"],["stra"],["istanbul"],["ligature"],[],[],["combining"],[],["sure"],["rien","est","attendu","de","vous"],["ouvre","les","reglages","de","floppy","il","te","plait"],["tres","surpris"],["un","peu","triste"],["joie"],["joie"],["ca","fait","000","voila"],["projet","differendum","env","stg"],[],["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],["un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix"],["tiret"],["like","it","please","don","stop"]],
  compact: ["","","ete","ete","cur","uvreuf","lete","lete","lete","dont","dont","its","imsure","wellknown","peutetre","abc123","deuxespaces","ab","tabnewline","helloworld","cava","ok","naivecafe","strae","istanbul","ligature","abcde","","xcombining","","sure","riennestattendudevous","ouvrelesreglagesdefloppysilteplait","tressurpris","unpeutriste","joie","joie","cafait3000voila","projetdifferendumenvstg2","abcd","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxe","undeuxtroisquatrecinqsixsepthuitneufdix","tiret","idlikeitpleasedontstop"],
  normWord: ["","","ete","ete","cur","uvreuf","lete","lete","lete","dont","dont","its","imsure","wellknown","peutetre","abc","deuxespaces","ab","tabnewline","helloworld","cava","ok","naivecafe","strae","istanbul","ligature","abcde","","xcombining","","sure","riennestattendudevous","ouvrelesreglagesdefloppysilteplait","tressurpris","unpeutriste","joie","joie","cafaitvoila","projetdifferendumenvstg","abcd","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxe","undeuxtroisquatrecinqsixsepthuitneufdix","tiret","idlikeitpleasedontstop"],
  tokens: [[],[],["ete"],["ete"],["c","ur"],["uvre","uf"],["l","ete"],["l","ete"],["l","ete"],["don","t"],["don","t"],["it","s"],["i","m","sure"],["well","known"],["peut","etre"],["abc123"],["deux","espaces"],["a","b"],["tab","new","line"],["hello","world"],["ca","va"],["ok"],["naive","cafe"],["stra","e"],["istanbul"],["ligature"],["a","b","c","d","e"],[],["x","combining"],[],["sure"],["rien","n","est","attendu","de","vous"],["ouvre","les","reglages","de","floppy","s","il","te","plait"],["tres","surpris"],["un","peu","triste"],["joie"],["joie"],["ca","fait","3","000","voila"],["projet","differendum","env","stg","2"],["a","b","c","d"],["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","e"],["un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix"],["tiret"],["i","d","like","it","please","don","t","stop"]],
  slugDocs: ["","","ete","ete","c-ur","uvre-uf","l-ete","l-ete","l-ete","don-t","don-t","it-s","i-m-sure","well-known","peut-etre","abc123","deux-espaces","a-b","tab-new-line","hello-world","ca-va","ok","naive-cafe","stra-e","istanbul","ligature","a-b-c-d-e","","x-combining","","sure","rien-n-est-attendu-de-vous","ouvre-les-reglages-de-floppy-s-il-te-pla","tres-surpris","un-peu-triste","joie","joie","ca-fait-3-000-voila","projet-differendum-env-stg-2","a-b-c-d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","un-deux-trois-quatre-cinq-six-sept-huit","tiret","i-d-like-it-please-don-t-stop"],
  slugSessions: ["","","ete","ete","c-ur","uvre-uf","l-ete","l-ete","l-ete","don-t","don-t","it-s","i-m-sure","well-known","peut-etre","abc123","deux-espaces","a-b","tab-new-line","hello-world","ca-va","ok","naive-cafe","stra-e","istanbul","ligature","a-b-c-d-e","","x-combining","","sure","rien-n-est-attendu-de-vous","ouvre-les-reglages-de-floppy-s","tres-surpris","un-peu-triste","joie","joie","ca-fait-3-000-voila","projet-differendum-env-stg-2","a-b-c-d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-e","un-deux-trois-quatre-cinq-six","tiret","i-d-like-it-please-don"],
  slugMcp: ["commande","commande","ete","ete","c_ur","uvre_uf","l_ete","l_ete","l_ete","don_t","don_t","it_s","i_m_sure","well_known","peut_etre","abc123","deux_espaces","a_b","tab_new_line","hello_world","ca_va","ok","naive_cafe","stra_e","istanbul","ligature","a_b_c_d_e","commande","x_combining","commande","sure","rien_n_est_attendu_de_vous","ouvre_les_reglages_de_floppy_s_il_te_plait","tres_surpris","un_peu_triste","joie","joie","ca_fait_3_000_voila","projet_differendum_env_stg_2","a_b_c_d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","un_deux_trois_quatre_cinq_six_sept_huit_neuf_dix","tiret","i_d_like_it_please_don_t_stop"],
  annSentence: ["","","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l'ete","l'ete","don`t","don't","it's","i'm sure","well-known","peut-etre","abc123","deux   espaces","a\u00a0b","tab\tnew\nline","hello, world","ca va","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","","sure","rien n'est attendu de vous","ouvre les reglages de floppy, s'il te plait","tres surpris+","un peu triste","joie-","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don't stop"],
  stripThenLower: [""," ","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l\u2019ete","l\u2018ete","don`t","don't","it's","i\u2019m sure","well-known","peut-etre","abc123","  deux   espaces  ","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","a^b`c\u00a8d~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n\u2019est attendu de vous.","ouvre les reglages de floppy, s\u2019il te plait ?","  tres surpris+ ","un peu triste"," joie- ","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don\u2019t stop."],
  m365: [""," ","ete","ete","c\u0153ur","\u0153uvre \u0153uf","l'ete","l\u2019ete","l\u2018ete","dont","don't","it's","i\u2019m sure","well-known","peut-etre","abc123","  deux   espaces  ","a\u00a0b","tab\tnew\nline","hello, world!","ca va ?","\ud83d\ude42 ok","naive cafe","stra\u00dfe \u00df","istanbul","\ufb01 ligature","abcd~e","\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2 \u03b1\u03c2","x combining","!!!","sure!","rien n\u2019est attendu de vous.","ouvre les reglages de floppy, s\u2019il te plait ?","  tres surpris+ ","un peu triste"," joie- ","[joie]","ca fait 3 000 \u20ac \u2014 voila\u2026","projet differendum / env-stg_2","a-b_c d","xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx e","un deux trois quatre cinq six sept huit neuf dix","- -tiret- -","i'd like it, please. don\u2019t stop."],
};

// Les mêmes familles, écrites avec les briques partagées, comme dans les fichiers qui les utilisent.
const SHARED: Record<string, (s: string) => unknown> = {
  fold: (s: string) => fold(s),
  foldTrim: (s: string) => fold(s).trim(), // noyau (settings, catalog), scheduler, orca/index
  trimFold: (s: string) => fold(s.trim()), // agent-cli/offers, protocol/parseEmotionTag
  foldApos: (s: string) => fold(s).replace(/['’]/g, " "), // conversation/feel
  foldCurly: (s: string) => fold(s).replace(/[’]/g, "'").trim(), // body-electron (commande « ouvre les réglages »)
  claim: (s: string) => fold(s).replace(/[’`]/g, "'").replace(/\s+/g, " ").trimStart(), // brain-aisdk/claimState
  foldSpaces: (s: string) => fold(s).replace(/\s+/g, " ").trim(), // orca/speech
  wordsKey: (s: string) => wordsKey(s), // noyau (tasks), veille/pretri, documents, orca/references
  echoWords: (s: string) => wordsKey(s).split(" ").filter(Boolean), // conversation/echo
  veilleWords: (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2),
  compact: (s: string) => fold(s).replace(/[^a-z0-9]/g, ""), // body-electron/settings-target
  normWord: (s: string) => normWord(s),
  tokens: (s: string) => foldTokens(s), // conversation/text, wakeword-stt
  slugDocs: (s: string) => slugify(s).slice(0, 40).replace(/-+$/, ""),
  slugSessions: (s: string) => slugify(s).split("-").slice(0, 6).join("-"),
  slugMcp: (s: string) => slugify(s, "_").slice(0, 60) || "commande",
  annSentence: (s: string) => fold(s).replace(/[’‘]/g, "'").replace(/[.!?]+$/, "").trim(), // orca/announcement
  stripThenLower: (s: string) => fold(s), // orca/announcement, orca/runtime : accents retirés puis minuscules
};

describe("normalisation de texte : comportement d'origine figé", () => {
  for (const name of Object.keys(GOLDEN)) {
    it(`${name} : expressions d'origine`, () => {
      expect(INPUTS.map((s) => LEGACY[name]!(s))).toEqual(GOLDEN[name]);
    });
  }
});

describe("normalisation de texte : briques partagées", () => {
  for (const name of Object.keys(SHARED)) {
    it(`${name} : même sortie qu'avant`, () => {
      expect(INPUTS.map((s) => SHARED[name]!(s))).toEqual(GOLDEN[name]);
    });
  }

  it("stripAccents ne touche ni la casse ni la ponctuation", () => {
    expect(stripAccents("Été, l’Œuvre ÇA")).toBe("Ete, l’Œuvre CA");
  });

  it("minuscules avant ou après les accents : même texte, sur tous les points de code", () => {
    const after = (s: string) => stripAccents(s).toLowerCase();
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      for (const s of [c, "a" + c, "Σ" + c, c + "Σ", "ΑΣ" + c, c + "\u0301"]) if (fold(s) !== after(s)) throw new Error(`divergence sur U+${cp.toString(16)}`);
    }
  });

  it("slugify : bords nettoyés, séparateur choisi", () => {
    expect(slugify("  Été 2024 !  ")).toBe("ete-2024");
    expect(slugify("Été 2024 !", "_")).toBe("ete_2024");
    expect(slugify("!!!")).toBe("");
  });
});
