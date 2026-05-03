import { createFileRoute } from "@tanstack/react-router";
import { PetsApp } from "@/app/pets/App";

export const Route = createFileRoute("/pets")({
  component: PetsApp,
});
