import React, { useEffect, useRef } from "react";
import "./AsciiBlackHole.css";

const CHARS = " .:-=+*#%@"; // Ordered by apparent brightness

interface AsciiBlackHoleProps {
  width?: number;
  height?: number;
}

export const AsciiBlackHole: React.FC<AsciiBlackHoleProps> = ({
  width = 80,
  height = 40,
}) => {
  const preRef = useRef<HTMLPreElement>(null);
  const glowRef = useRef<HTMLPreElement>(null);
  const requestRef = useRef<number | undefined>(undefined);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    const animate = () => {
      timeRef.current += 0.015; // Speed of time
      const t = timeRef.current;
      const cx = width / 2;
      const cy = height / 2;

      let frame = "";

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // Normalized coordinates (-1 to 1)
          const dx = (x - cx) / (width / 2);
          const dy = (y - cy) / (height / 2);
          
          // Aspect ratio correction (chars are usually ~2x taller than wide)
          const aspect = 0.55; 
          const dist = Math.sqrt(dx * dx + (dy * dy) / (aspect * aspect));
          
          let charIndex = 0;

          // The Event Horizon (radius ~ 0.3)
          if (dist < 0.15) {
            // The Singularity (Pure Black)
            charIndex = 0;
          } else {
            // The Accretion Disk & Gravitational Lensing
            // Angle of the coordinate
            const angle = Math.atan2(dy, dx);
            
            // Swirl calculation: The closer to center, the faster the swirl
            // Distortion factor increases as dist -> 0
            const spiralOffset = 1.0 / (dist + 0.05); 
            
            // Calculate wave patterns
            // We combine multiple sine waves to create "turbulence"
            const wave1 = Math.sin(angle * 3 + spiralOffset * 2 - t * 3);
            const wave2 = Math.cos(angle * 5 - spiralOffset * 3 + t * 2);
            
            // Intensity based on waves and distance
            // Brighter near the horizon (dist ~ 0.2 to 0.4)
            let intensity = (wave1 + wave2) * 0.5 + 0.5; // 0 to 1
            
            // Falloff: Intensity drops as we go further out
            const falloff = Math.max(0, 1 - (dist - 0.15) * 1.5);
            
            // Accretion disk highlight
            const disk = Math.exp(-Math.pow((dist - 0.3) * 10, 2));
            
            let finalVal = intensity * falloff + disk * 0.8;

            // Clamp
            charIndex = Math.floor(Math.min(finalVal, 1) * (CHARS.length - 1));
            charIndex = Math.max(0, charIndex);
          }

          frame += CHARS[charIndex];
        }
        frame += "\n";
      }

      if (preRef.current) {
        preRef.current.innerText = frame;
      }
      if (glowRef.current) {
        glowRef.current.innerText = frame;
      }

      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [width, height]);

  return (
    <div className="ascii-black-hole-container">
      <pre ref={glowRef} className="ascii-pre ascii-pre-glow" aria-hidden="true" />
      <pre ref={preRef} className="ascii-pre" />
    </div>
  );
};
