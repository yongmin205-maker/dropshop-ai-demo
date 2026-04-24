export interface PresetScenario {
  id: string;
  label: string;
  customer: { name: string; phone: string };
  body: string;
  intentHint:
    | "Pickup Request"
    | "ETA/Order Status"
    | "Alteration Quote"
    | "Membership & Pricing"
    | "Critical Escalation";
  description: string;
}

export const PRESET_SCENARIOS: PresetScenario[] = [
  {
    id: "repeat-pickup",
    label: "Repeat Pickup",
    customer: { name: "Peter Demarco", phone: "+15550101003" },
    body: "Pick up for Peter today please. Same as last time.",
    intentHint: "Pickup Request",
    description: "Loyal bi-weekly customer asking for the usual pickup.",
  },
  {
    id: "eta-inquiry",
    label: "ETA Inquiry",
    customer: { name: "Marie Pierce", phone: "+15550101001" },
    body: "Hi! Where is my laundry? Was supposed to arrive this morning.",
    intentHint: "ETA/Order Status",
    description: "Gold member checking on a delayed delivery window.",
  },
  {
    id: "zipper-quote",
    label: "Zipper Photo Quote",
    customer: { name: "Alexandra Klein", phone: "+15550101002" },
    body: "Hey — how much would it be to replace this jacket zipper? [photo]",
    intentHint: "Alteration Quote",
    description: "Customer sends a photo of a broken jacket zipper for a price.",
  },
  {
    id: "membership-question",
    label: "Membership Question",
    customer: { name: "Shannan Barrett", phone: "+15550101004" },
    body:
      "Quick q — what's the member rate for a wool coat? And what comes with the gold plan?",
    intentHint: "Membership & Pricing",
    description: "Gold member double-checking pricing + plan benefits.",
  },
  {
    id: "theft-report",
    label: "Theft Report (Critical)",
    customer: { name: "Building Super (975 Park)", phone: "+15553240000" },
    body:
      "Hi this is the super at 975 Park Ave. Apt 14D's garment bag was taken from the lobby this morning. Sending you 4 CCTV stills. Is this your driver??",
    intentHint: "Critical Escalation",
    description:
      "Building superintendent reports a possible theft with CCTV evidence — must escalate.",
  },
];
