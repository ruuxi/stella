import * as React from "react";
import { cn } from "@/lib/utils";

const icons: Record<string, string> = {
  "check-small": `<path d="M6.5 11.4412L8.97059 13.5L13.5 6.5" stroke="currentColor" stroke-linecap="square"/>`,
  "chevron-down": `<path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square"/>`,
  "chevron-right": `<path d="M8.33301 13.3327L11.6663 9.99935L8.33301 6.66602" stroke="currentColor" stroke-linecap="square"/>`,
  "chevron-grabber-vertical": `<path d="M6.66675 12.4998L10.0001 15.8332L13.3334 12.4998M6.66675 7.49984L10.0001 4.1665L13.3334 7.49984" stroke="currentColor" stroke-linecap="square"/>`,
  close: `<path d="M3.75 3.75L16.25 16.25M16.25 3.75L3.75 16.25" stroke="currentColor" stroke-linecap="square"/>`,
  "circle-x": `<path fill-rule="evenodd" clip-rule="evenodd" d="M1.6665 10.0003C1.6665 5.39795 5.39746 1.66699 9.99984 1.66699C14.6022 1.66699 18.3332 5.39795 18.3332 10.0003C18.3332 14.6027 14.6022 18.3337 9.99984 18.3337C5.39746 18.3337 1.6665 14.6027 1.6665 10.0003ZM7.49984 6.91107L6.91058 7.50033L9.41058 10.0003L6.91058 12.5003L7.49984 13.0896L9.99984 10.5896L12.4998 13.0896L13.0891 12.5003L10.5891 10.0003L13.0891 7.50033L12.4998 6.91107L9.99984 9.41107L7.49984 6.91107Z" fill="currentColor"/>`,
  copy: `<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>`,
  check: `<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>`,
  "circle-check": `<path d="M12.4987 7.91732L8.7487 12.5007L7.08203 10.834M17.9154 10.0007C17.9154 14.3729 14.371 17.9173 9.9987 17.9173C5.62644 17.9173 2.08203 14.3729 2.08203 10.0007C2.08203 5.6284 5.62644 2.08398 9.9987 2.08398C14.371 2.08398 17.9154 5.6284 17.9154 10.0007Z" stroke="currentColor" stroke-linecap="square"/>`,
  expand: `<path d="M4.58301 10.4163V15.4163H9.58301M10.4163 4.58301H15.4163V9.58301" stroke="currentColor" stroke-linecap="square"/>`,
  collapse: `<path d="M16.666 8.33398H11.666V3.33398" stroke="currentColor" stroke-linecap="square"/><path d="M8.33398 16.666V11.666H3.33398" stroke="currentColor" stroke-linecap="square"/>`,
  "magnifying-glass": `<path d="M15.8332 15.8337L13.0819 13.0824M14.6143 9.39088C14.6143 12.2759 12.2755 14.6148 9.39039 14.6148C6.50532 14.6148 4.1665 12.2759 4.1665 9.39088C4.1665 6.5058 6.50532 4.16699 9.39039 4.16699C12.2755 4.16699 14.6143 6.5058 14.6143 9.39088Z" stroke="currentColor" stroke-linecap="square"/>`,
  plus: `<path d="M9.9987 2.20703V9.9987M9.9987 9.9987V17.7904M9.9987 9.9987H2.20703M9.9987 9.9987H17.7904" stroke="currentColor" stroke-linecap="square"/>`,
  "plus-small": `<path d="M9.99984 5.41699V10.0003M9.99984 10.0003V14.5837M9.99984 10.0003H5.4165M9.99984 10.0003H14.5832" stroke="currentColor" stroke-linecap="square"/>`,
  edit: `<path d="M17.0832 17.0807V17.5807H17.5832V17.0807H17.0832ZM2.9165 17.0807H2.4165V17.5807H2.9165V17.0807ZM2.9165 2.91406V2.41406H2.4165V2.91406H2.9165ZM9.58317 3.41406H10.0832V2.41406H9.58317V2.91406V3.41406ZM17.5832 10.4141V9.91406H16.5832V10.4141H17.0832H17.5832ZM6.24984 11.2474L5.89628 10.8938L5.74984 11.0403V11.2474H6.24984ZM6.24984 13.7474H5.74984V14.2474H6.24984V13.7474ZM8.74984 13.7474V14.2474H8.95694L9.10339 14.101L8.74984 13.7474ZM15.2082 2.28906L15.5617 1.93551L15.2082 1.58196L14.8546 1.93551L15.2082 2.28906ZM17.7082 4.78906L18.0617 5.14262L18.4153 4.78906L18.0617 4.43551L17.7082 4.78906ZM17.0832 17.0807V16.5807H2.9165V17.0807V17.5807H17.0832V17.0807ZM2.9165 17.0807H3.4165V2.91406H2.9165H2.4165V17.0807H2.9165ZM2.9165 2.91406V3.41406H9.58317V2.91406V2.41406H2.9165V2.91406ZM17.0832 10.4141H16.5832V17.0807H17.0832H17.5832V10.4141H17.0832ZM6.24984 11.2474H5.74984V13.7474H6.24984H6.74984V11.2474H6.24984ZM6.24984 13.7474V14.2474H8.74984V13.7474V13.2474H6.24984V13.7474ZM6.24984 11.2474L6.60339 11.6009L15.5617 2.64262L15.2082 2.28906L14.8546 1.93551L5.89628 10.8938L6.24984 11.2474ZM15.2082 2.28906L14.8546 2.64262L17.3546 5.14262L17.7082 4.78906L18.0617 4.43551L15.5617 1.93551L15.2082 2.28906ZM17.7082 4.78906L17.3546 4.43551L8.39628 13.3938L8.74984 13.7474L9.10339 14.101L18.0617 5.14262L17.7082 4.78906Z" fill="currentColor"/>`,
  folder: `<path d="M2.08301 2.91675V16.2501H17.9163V5.41675H9.99967L8.33301 2.91675H2.08301Z" stroke="currentColor" stroke-linecap="round"/>`,
  stop: `<rect x="5" y="5" width="10" height="10" fill="currentColor"/>`,
  menu: `<path d="M2.5 5H17.5M2.5 10H17.5M2.5 15H17.5" stroke="currentColor" stroke-linecap="square"/>`,
  trash: `<path d="M4.16667 5.83333H15.8333M8.33333 8.75V14.5833M11.6667 8.75V14.5833M5 5.83333L5.83333 16.6667H14.1667L15 5.83333M7.5 5.83333V3.33333H12.5V5.83333" stroke="currentColor" stroke-linecap="square"/>`,
  retry: `<path d="M16.6667 10C16.6667 13.6819 13.6819 16.6667 10 16.6667C6.31811 16.6667 3.33333 13.6819 3.33333 10C3.33333 6.31811 6.31811 3.33333 10 3.33333C12.5 3.33333 14.6667 4.75 15.8333 6.875M15.8333 3.33333V7.08333H12.0833" stroke="currentColor" stroke-linecap="square"/>`,
  download: `<path d="M13.9583 10.6257L10 14.584L6.04167 10.6257M10 2.08398V13.959M16.25 17.9173H3.75" stroke="currentColor" stroke-linecap="square"/>`,
  share: `<path d="M10.0013 12.0846L10.0013 3.33464M13.7513 6.66797L10.0013 2.91797L6.2513 6.66797M17.0846 10.418V17.0846H2.91797V10.418" stroke="currentColor" stroke-linecap="square"/>`,
  "settings-gear": `<path d="M9.99999 1L18 5.49998L18 14.5001L9.99998 19L2 14.5003L2 5.49996L9.99999 1Z" stroke="currentColor" stroke-linecap="square"/><path d="M13.2941 10.0001C13.2941 11.8313 11.8193 13.3159 10 13.3159C8.18073 13.3159 6.7059 11.8313 6.7059 10.0001C6.7059 8.16879 8.18073 6.68425 10 6.68425C11.8193 6.68425 13.2941 8.16879 13.2941 10.0001Z" stroke="currentColor" stroke-linecap="square"/>`,
  selector: `<path d="M6.66626 12.5033L9.99959 15.8366L13.3329 12.5033M6.66626 7.50326L9.99959 4.16992L13.3329 7.50326" stroke="currentColor" stroke-linecap="square"/>`,
};

export type IconName = keyof typeof icons;

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  name: IconName;
  size?: "small" | "normal" | "medium" | "large";
}

export function Icon({ name, size = "normal", className, ...props }: IconProps) {
  const iconPath = icons[name];
  
  if (!iconPath) {
    console.warn(`Icon "${name}" not found`);
    return null;
  }

  return (
    <div data-component="icon" data-size={size}>
      <svg
        data-slot="icon-svg"
        className={cn(className)}
        fill="none"
        viewBox="0 0 20 20"
        dangerouslySetInnerHTML={{ __html: iconPath }}
        aria-hidden="true"
        {...props}
      />
    </div>
  );
}
