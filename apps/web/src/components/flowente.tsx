const frames = ["flowente-p1", "flowente-p2", "flowente-p3"];

export function FlowenteSvgFilters() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {[
          { id: "flowente-p1", seed: 1 },
          { id: "flowente-p2", seed: 7 },
          { id: "flowente-p3", seed: 13 }
        ].map((filter) => (
          <filter id={filter.id} key={filter.id} x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves={2} seed={filter.seed} result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" />
          </filter>
        ))}
      </defs>
    </svg>
  );
}

export function FlowenteMarkBadge() {
  return (
    <span className="flowente-mark-badge" aria-hidden="true">
      <span className="flowente-accent-shape" />
      <span className="boil flowente-flow-mark">
        {frames.map((filter) => (
          <svg key={filter} viewBox="0 0 340 230">
            <path
              className="mark-stroke"
              filter={`url(#${filter})`}
              d="M20,150 C20,105 60,105 60,150 C60,105 100,105 100,150 C100,105 140,105 145,150 C152,190 200,190 205,140 C210,95 250,95 258,150 C265,195 315,195 320,120"
            />
          </svg>
        ))}
      </span>
    </span>
  );
}
