import {
  Camera,
  MessageSquare,
  Mic,
  Plus,
  type IconComponent,
} from "@/ui/icons";

type RadialWedgeId = "capture" | "chat" | "add" | "voice";

type RadialWedge = {
  id: RadialWedgeId;
  label: string;
  icon: IconComponent;
  heading: string;
  detail: string;
};

// Order matches the real Stella radial: top → right → bottom → left.
export const RADIAL_WEDGES: RadialWedge[] = [
  {
    id: "capture",
    label: "Capture",
    icon: Camera,
    heading: "Grab what's on screen",
    detail: "Capture any page or document and Stella instantly gets it.",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    heading: "Chat with context",
    detail: "The conversation opens already knowing what you're looking at.",
  },
  {
    id: "add",
    label: "Add",
    icon: Plus,
    heading: "Add to your conversation",
    detail: "Pin what you grabbed to the current chat without switching apps.",
  },
  {
    id: "voice",
    label: "Voice",
    icon: Mic,
    heading: "Just talk",
    detail: "Dictate notes, ask questions, give instructions, hands-free.",
  },
];
