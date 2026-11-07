# Project pitch (5 minutes, due Oct. 19)

The brief asks for three things: which part of the problem the team is addressing, a quick overview of **two concept solutions**, and the hardware required. Suggested slide plan and script below; put it in your own words when you record.

## Slide 1 — The problem (0:00–0:50)

> CCCARE gives every participant a personalised exercise dose. Three things stop that from scaling.
> The dose lives on paper and in an Access database that nothing else can read, so adjusting it means digging through binders.
> One instructor supervises 10 to 12 patients, or up to 30 graduates, and cannot see who finished their dose, who stopped halfway, or who is overdoing it.
> And fewer than 10% of stroke and cancer patients referred from the hospital get treated at all, because there is no room and some cannot travel.

**On screen:** the three bullets, and the "<10%" figure large.

## Slide 2 — What we are addressing (0:50–1:30)

> These are one problem, not three. A dose is prescribed, performed, measured and adjusted. Today that loop is broken at "measured".
> We focus on sub-problem 2, tracking and measuring exercise quality, and design it so the measurements feed the dose record (sub-problem 1) and work the same way at home (sub-problem 3).

**On screen:** a loop diagram: Prescribe → Perform → Measure → Adjust.

Requirements to state:

- Counts repetitions and reports dose completed per participant, without a volunteer watching.
- Says something about *quality*, not only quantity.
- Works for an older adult with no setup skill: strap on, press one button.
- No cameras. Participants are patients, some exercising at home.
- Costs little enough per participant to hand out 30.

## Slide 3 — Concept A: wearable motion tracker (1:30–2:40)

> A small sensor straps to the limb doing the work. An accelerometer measures the limb's angle 50 times a second. The microcontroller counts each repetition and scores it on range of motion, tempo and smoothness. A pulse sensor checks heart rate against a safe ceiling. A buzzer tells the participant when the dose is reached.
> Results go to a dashboard where the instructor sees the whole class live, and into each participant's record, where the system suggests whether to progress, hold or reduce the dose.

**On screen:** photo or sketch of the strap on a thigh; screenshot of the Live class board.

- Strengths: private (motion numbers only), cheap, works at home, per-rep quality.
- Weaknesses: one limb per sensor; the participant has to put it on; needs calibration per exercise.

## Slide 4 — Concept B: instrumented exercise station (2:40–3:40)

> Instead of the person wearing a sensor, the equipment is instrumented. A chair with a load cell under the seat counts sit-to-stands and times each one. An ultrasonic distance sensor on a weight stack or a wall station counts lifts. Participants tap an RFID card to tell the station who they are.

**On screen:** sketch of the chair and the card tap.

- Strengths: nothing to wear, nothing to forget; very robust counting; good for participants with dementia.
- Weaknesses: one station per exercise; fixed to the clinic, so it does nothing for at-home care; weaker quality measurement (it sees the load, not the limb).

## Slide 5 — Comparison and choice (3:40–4:20)

| | A: Wearable | B: Station |
|---|---|---|
| Works at home | Yes | No |
| Effort for the participant | Strap on, one button | Tap a card |
| Measures quality | Range, tempo, smoothness | Tempo only |
| Cost to cover a class of 12 | 12 units | 1 per exercise type |
| Privacy | Motion data only | Motion data only |

> We are going ahead with Concept A, because it is the only one that also serves the at-home problem, and it measures quality per repetition.

## Slide 6 — Hardware (4:20–5:00)

| Part | Purpose |
|---|---|
| STM32 Nucleo-F401RE | Runs rep detection and scoring |
| MPU-6050 accelerometer | Limb angle |
| Analog pulse sensor | Heart rate |
| Active buzzer, on-board LED and button | Feedback and start/stop |
| Elastic strap, jumper wires, USB cable | Mounting and connection |

For Concept B the list would instead be: load cell with HX711 amplifier, HC-SR04 ultrasonic sensor, RC522 RFID reader.

> By the update presentation we will show the wearable counting sit-to-stands live on the dashboard.

## Likely questions

- **How accurate is the count?** In simulation it is exact on clean and rushed reps and reports shallow reps separately. On people it needs measuring: plan a test of 10 reps × 5 people × 3 exercises against a hand count.
- **What if they do the wrong exercise?** The sensor checks that a movement matches the prescribed range and tempo, not which exercise it is. The app shows one exercise at a time with its cue.
- **Why not a phone camera?** Privacy at home, lighting, and setup difficulty for this age group.
- **What happens with the data?** One record per participant; kinesiologists see everything, the group feed shows first name and last initial only. Real deployment needs logins and a PHIPA review.

## For the Nov. 9 update and the symposium

- Bring the Nucleo with the strap and run a session in the Participant view next to the Live class board on a second window.
- If the hardware misbehaves on the day, the **Demo sensor** runs the identical flow.
- Measured results to bring: count accuracy against a hand count, and quality scores for deliberately good versus sloppy reps.
