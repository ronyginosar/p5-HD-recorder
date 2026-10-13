// Minimal p5-HD-recorder demo: a frameCount-driven loop, so every recording is identical.

const CANVAS_WIDTH = 540;
const CANVAS_HEIGHT = 675;
const LOOP_FRAMES = 120; // one full rotation every 2 s at 60 fps → seamless loop

function setup() {
  createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT, WEBGL);
  pixelDensity(2); // set once here, never in draw()
  // optional per-sketch recorder settings: stop automatically after exactly one loop
  Recorder.configure({ durationSeconds: LOOP_FRAMES / 60 });
}

function draw() {
  background(200, 200, 200);
  noStroke();

  const loopPhase = (frameCount % LOOP_FRAMES) / LOOP_FRAMES;
  // 'camera' angle & controls
  orbitControl()
  rotateX(-PI / 4);
  rotateY(-PI / 8);
  rotateZ(-PI / 8);

  // rotation animation
  let axis = [1, 0, 0];

  let r = min(width, height) * 0.2;
  translate(-r / 2, 0, 0); // center the graphics on canvas

  // 1st torus
  normalMaterial();
  push();
  rotate(loopPhase * TWO_PI, axis);
  rotateZ(1.1);
  torus(r, r * 0.5, 100, 100);
  pop();

  // 2nd torus
  translate(r, 0, 0);
  rotate(loopPhase * TWO_PI, axis);
  normalMaterial();
  rotateX(PI / 4); // create the interlock position
  torus(r, r * 0.45, 100, 100);

  resetMatrix(); // Reset transformation matrix to draw 2D elements
}
