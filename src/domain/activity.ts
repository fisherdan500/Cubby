export const activityTypes = [
  "feeding",
  "diaper",
  "sleep",
  "pumping",
  "medicine",
  "measurement",
  "milestone",
  "note",
  "bath",
  "play",
  "mood",
  "supplement",
  "vaccine",
  "milk_inventory"
] as const;

export type ActivityTypeName = (typeof activityTypes)[number];

export const activityLabels: Record<ActivityTypeName, string> = {
  feeding: "Feeding",
  diaper: "Diaper",
  sleep: "Sleep",
  pumping: "Pumping",
  medicine: "Medicine",
  measurement: "Measurement",
  milestone: "Milestone",
  note: "Note",
  bath: "Bath",
  play: "Play",
  mood: "Mood",
  supplement: "Supplement",
  vaccine: "Vaccine",
  milk_inventory: "Milk inventory"
};

export const timerActivityTypes = ["feeding", "sleep", "pumping", "play"] as const satisfies ActivityTypeName[];

export const activityAccent: Record<ActivityTypeName, string> = {
  feeding: "bg-sky-300 text-slate-950",
  diaper: "bg-teal-400 text-slate-950",
  sleep: "bg-slate-500 text-white",
  pumping: "bg-fuchsia-300 text-slate-950",
  medicine: "bg-emerald-300 text-slate-950",
  measurement: "bg-orange-300 text-slate-950",
  milestone: "bg-indigo-300 text-slate-950",
  note: "bg-amber-200 text-slate-950",
  bath: "bg-cyan-300 text-slate-950",
  play: "bg-lime-300 text-slate-950",
  mood: "bg-rose-300 text-slate-950",
  supplement: "bg-violet-300 text-slate-950",
  vaccine: "bg-red-300 text-slate-950",
  milk_inventory: "bg-blue-300 text-slate-950"
};

export function isActivityType(value: string): value is ActivityTypeName {
  return activityTypes.includes(value as ActivityTypeName);
}
