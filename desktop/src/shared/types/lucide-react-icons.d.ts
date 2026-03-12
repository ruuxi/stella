declare module "lucide-react/dist/esm/icons/*" {
  import type { ForwardRefExoticComponent, RefAttributes } from "react";
  import type { LucideProps } from "lucide-react";

  const Icon: ForwardRefExoticComponent<
    Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
  >;

  export default Icon;
}
