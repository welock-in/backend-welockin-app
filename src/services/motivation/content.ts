export type MotivationText = {
  key: string;
  kind: "regular" | "return";
  needsName?: boolean;
  fr: { title: string; body: string };
  en: { title: string; body: string };
};

// Reviewed copy. Time is mentioned only where it was part of the agreed text.
// Keys are stable so recently delivered messages can be excluded on later days.
export const MOTIVATION_TEXTS: readonly MotivationText[] = [
  { key: "plot-twist", kind: "regular", fr: { title: "Plot twist", body: "Tu peux encore avancer aujourd’hui. Une session de 25 minutes ?" }, en: { title: "Plot twist", body: "You can still make progress today. How about a 25-minute session?" } },
  { key: "thumb", kind: "regular", fr: { title: "Ton pouce a assez travaillé", body: "Et si on donnait 25 minutes à ton cerveau maintenant ?" }, en: { title: "Your thumb has done enough", body: "How about giving your brain 25 minutes now?" } },
  { key: "plan", kind: "regular", fr: { title: "J’ai un plan", body: "Toi, une tâche, 25 minutes. Franchement, il est solide." }, en: { title: "I have a plan", body: "You, one task, 25 minutes. Honestly, it’s a good plan." } },
  { key: "short", kind: "regular", fr: { title: "Je fais court", body: "C’est ton signal pour commencer. Voilà, j’ai fini." }, en: { title: "I’ll keep it short", body: "This is your sign to start. That’s it. I’m done." } },
  { key: "future-self", kind: "regular", fr: { title: "Petite réunion avec ton futur toi", body: "Il aimerait beaucoup que tu lances une session." }, en: { title: "A meeting with future you", body: "They’d really like you to start a focus session." } },
  { key: "scroll-turn", kind: "regular", fr: { title: "Le scroll a eu son tour", body: "Maintenant, c’est au tour de ton projet." }, en: { title: "Scrolling had its turn", body: "Now it’s your project’s turn." } },
  { key: "intervention", kind: "regular", fr: { title: "Ceci est une intervention", body: "Ton cours ne va pas s’ouvrir tout seul. On commence ?" }, en: { title: "This is an intervention", body: "Your study notes won’t open themselves. Shall we start?" } },
  { key: "quiet-after", kind: "regular", fr: { title: "Je te laisse tranquille après", body: "Promis. Lance juste une session de 25 minutes." }, en: { title: "I’ll leave you alone after", body: "Promise. Just start a 25-minute session." } },
  { key: "name-proposal", kind: "regular", needsName: true, fr: { title: "{{name}}, j’ai une proposition", body: "25 minutes pour ton objectif. Zéro négociation avec les distractions." }, en: { title: "{{name}}, I have a proposal", body: "25 minutes for your goal. No negotiating with distractions." } },
  { key: "motivation-late", kind: "regular", fr: { title: "La motivation est en retard", body: "On commence sans elle ? 25 minutes suffisent." }, en: { title: "Motivation is running late", body: "Shall we start without it? 25 minutes will do." } },
  { key: "sign", kind: "regular", fr: { title: "Si tu cherchais un signe", body: "C’est celui-ci. Choisis une tâche et lance une session." }, en: { title: "If you were looking for a sign", body: "This is it. Pick one task and start a session." } },
  { key: "secret-plan", kind: "regular", fr: { title: "Le grand plan secret", body: "Faire une petite chose maintenant. Personne ne s’y attendra." }, en: { title: "The big secret plan", body: "Do one small thing now. Nobody will see it coming." } },
  { key: "brain-invite", kind: "regular", fr: { title: "Ton cerveau a une invitation", body: "Objet : avancer enfin. Durée : 25 minutes." }, en: { title: "Your brain has an invitation", body: "Subject: making progress. Duration: 25 minutes." } },
  { key: "wild-idea", kind: "regular", fr: { title: "On tente un truc fou ?", body: "Commencer avant d’avoir trouvé l’envie de commencer." }, en: { title: "Want to try something wild?", body: "Start before you feel like starting." } },
  { key: "moderate-alert", kind: "regular", fr: { title: "Alerte très modérée", body: "Il reste du temps pour faire quelque chose de bien aujourd’hui." }, en: { title: "A very moderate alert", body: "There’s still time to do something good today." } },
  { key: "help-start", kind: "regular", fr: { title: "Je peux t’aider à commencer", body: "Pour le reste, je te laisse prendre tout le mérite." }, en: { title: "I can help you start", body: "You can take all the credit for the rest." } },
  { key: "later-full", kind: "regular", fr: { title: "Le mode « plus tard » est plein", body: "Passe en mode concentration pendant 25 minutes." }, en: { title: "The ‘later’ queue is full", body: "Switch to focus mode for 25 minutes." } },
  { key: "minute-courage", kind: "regular", fr: { title: "Une minute de courage", body: "C’est tout ce qu’il faut pour appuyer sur « Démarrer »." }, en: { title: "One minute of courage", body: "That’s all it takes to tap Start." } },
  { key: "name-deal", kind: "regular", needsName: true, fr: { title: "{{name}}, marché conclu ?", body: "Tu lances une session, et j’arrête de parler." }, en: { title: "{{name}}, deal?", body: "You start a session, and I’ll stop talking." } },
  { key: "pretend-nothing", kind: "return", fr: { title: "On fait comme si de rien n’était ?", body: "Parfait. Reviens avec une petite session aujourd’hui." }, en: { title: "Pretend nothing happened?", body: "Perfect. Come back with one small session today." } },
  { key: "project-asked", kind: "return", fr: { title: "Ton projet m’a demandé de tes nouvelles", body: "Je lui ai dit que tu pouvais passer 25 minutes avec lui." }, en: { title: "Your project asked about you", body: "I said you might spend 25 minutes together." } },
  { key: "hello-again", kind: "return", fr: { title: "Rebonjour, toi", body: "Pas de grand discours. On reprend avec une session ?" }, en: { title: "Hey, you’re back", body: "No big speech. Ready for a session?" } },
  { key: "resume", kind: "return", fr: { title: "On reprend où on en était ?", body: "Pas besoin de tout rattraper. Une session, et c’est reparti." }, en: { title: "Pick up where we left off?", body: "No need to catch up on everything. One session is a start." } },
  { key: "saved-seat", kind: "return", fr: { title: "Je t’ai gardé une place", body: "Juste ici, pour 25 minutes de concentration." }, en: { title: "I saved you a spot", body: "Right here, for 25 minutes of focus." } },
];

export function renderMotivationText(text: MotivationText, language: string, name: string | null) {
  const copy = language === "fr" ? text.fr : text.en;
  const safeName = name?.trim().split(/\s+/)[0]?.slice(0, 30) ?? "";
  return {
    title: copy.title.replaceAll("{{name}}", safeName),
    body: copy.body.replaceAll("{{name}}", safeName),
  };
}
