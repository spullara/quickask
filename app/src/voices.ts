/** Gemini's 30 prebuilt voices (name: style). Without one, each request gets a random voice. */
export const VOICES: Record<string, string> = {
  zephyr: "Bright", puck: "Upbeat", charon: "Informative", kore: "Firm", fenrir: "Excitable", leda: "Youthful", orus: "Firm",
  aoede: "Breezy", callirrhoe: "Easy-going", autonoe: "Bright", enceladus: "Breathy", iapetus: "Clear", umbriel: "Easy-going",
  algieba: "Smooth", despina: "Smooth", erinome: "Clear", algenib: "Gravelly", rasalgethi: "Informative", laomedeia: "Upbeat",
  achernar: "Soft", alnilam: "Firm", schedar: "Even", gacrux: "Mature", pulcherrima: "Forward", achird: "Friendly",
  zubenelgenubi: "Casual", vindemiatrix: "Gentle", sadachbia: "Lively", sadaltager: "Knowledgeable", sulafat: "Warm",
};

/** The read-aloud voice when the person has not picked one. */
export const DEFAULT_VOICE = "leda";
