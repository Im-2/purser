import { useState } from "react";
import { Backdrop } from "../components/Backdrop";
import "./landing.css";
import { Hero, Loader, Nav } from "./Hero";
import { markIntroSeen, shouldShowIntro, useScrollReveal } from "./hooks";
import { Footer, Gallery, Pipeline, Problem, Proof } from "./Sections";

/** Public landing page, served at "/". The dashboard lives at "/app". Nothing here reads or shows any credential. */
export default function Landing() {
  const [intro] = useState(shouldShowIntro);
  const [ready, setReady] = useState(!intro);
  useScrollReveal(ready);

  return (
    <div className="landing" data-ready={ready}>
      <Backdrop />
      {!ready && (
        <Loader
          onDone={() => {
            markIntroSeen();
            setReady(true);
          }}
        />
      )}
      <a href="#main" className="focus-ring sr-only left-4 top-3 z-[100] rounded-full bg-ink px-4 py-2 text-on-ink focus:not-sr-only focus:fixed">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Problem />
        <Pipeline />
        <Gallery />
        <Proof />
      </main>
      <Footer />
    </div>
  );
}
