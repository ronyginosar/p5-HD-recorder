// Minimal p5-HD-recorder demo: a frameCount-driven loop, so every recording is identical.

const CANVAS_WIDTH = 540;
const CANVAS_HEIGHT = 675;
const LOOP_FRAMES = 120; // one full rotation every 2 s at 60 fps → seamless loop
const RING_COUNT = 12;

function setup() {
  createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  pixelDensity(2); // set once here, never in draw()
  // optional per-sketch recorder settings: stop automatically after exactly one loop
  Recorder.configure({ durationSeconds: LOOP_FRAMES / 60 });
}

function draw() {
  background(20);
  noFill();
  strokeWeight(3);
  translate(width / 2, height / 2);

  // rings rotate a full turn over LOOP_FRAMES, so the last frame meets the first
  const loopPhase = (frameCount % LOOP_FRAMES) / LOOP_FRAMES;
  for (let ringIndex = 0; ringIndex < RING_COUNT; ringIndex++) {
    stroke(255, 120 + ringIndex * 10, 80);
    push();
    rotate(TWO_PI * loopPhase + ringIndex * 0.2);
    ellipse(0, 0, 60 + ringIndex * 30, 30 + ringIndex * 15);
    pop();
  }
}
