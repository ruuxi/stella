import { Camera, MessageSquare, Mic, Plus, type LucideIcon } from "lucide-react";

type RadialWedgeId = "capture" | "chat" | "add" | "voice";

type RadialWedge = {
  id: RadialWedgeId;
  label: string;
  icon: LucideIcon;
  heading: string;
  detail: string;
};

// Order matches the real Stella radial: top → right → bottom → left.
export const RADIAL_WEDGES: RadialWedge[] = [
  {
    id: "capture",
    label: "Capture",
    icon: Camera,
    heading: "Grab what's on your screen",
    detail:
      "Capture whatever you're looking at — a webpage, a document, anything — and Stella instantly understands it.",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    heading: "Chat that already knows what you're doing",
    detail:
      "Stella sees what app or page you're on and picks up the conversation from there. No need to explain the context.",
  },
  {
    id: "add",
    label: "Add",
    icon: Plus,
    heading: "Add to your conversation",
    detail:
      "Pin what you grabbed to the current chat as context — no need to leave the app you're in.",
  },
  {
    id: "voice",
    label: "Voice",
    icon: Mic,
    heading: "Just talk to Stella",
    detail:
      "Speak naturally and Stella listens. Dictate notes, ask questions, or give instructions — hands-free, from anywhere.",
  },
];
