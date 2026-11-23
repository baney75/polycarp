# Polycarp research: how people who struggle with reading think, perceive and reason, and what that means for a reading tool

Prepared 2026-11-20 for the Polycarp project. Covers 12 groups, the W3C COGA Note, the WCAG 2.2 criteria a client-side tool can enforce, and cross-cutting evidence on bionic reading, RSVP, text-to-speech, retrieval practice and gamification.

**Tags.** EVIDENCE = peer-reviewed study, systematic review, or official guideline (W3C and WCAG count as official guidelines). PRACTICE = clinician, community, or industry guidance only. UNVERIFIED = I could not confirm the claim or the citation in this run.

**Method and limits.** Searches and page reads ran on 2026-11-20. The reader tool blocked PubMed and some W3C pages, so most PubMed records were confirmed from search-result summaries, not full text. Sample sizes and effect sizes appear only where a source gave them. Anything I did not open is marked.

**Corrections to the brief.** WCAG 1.4.8 Visual Presentation is Level AAA, not AA. The other criteria are 1.4.3 Contrast (Minimum) AA, 1.4.10 Reflow AA, 1.4.12 Text Spacing AA, 2.2.2 Pause, Stop, Hide A, and 2.3.1 Three Flashes or Below Threshold A.

**Bottom line for Polycarp.** The format Polycarp is built around, bionic bolding, has no published evidence of faster reading or better comprehension. Polycarp should not claim either.

---

## Part 1. Cross-cutting evidence

### 1.1 Bionic reading (Polycarp's core format)

- EVIDENCE: a single-author study in *Acta Psychologica* (2024) compared 100 paragraphs in bionic and normal fonts. It found no significant difference in reading time and concluded the font does not facilitate reading. [PubMed 38723450](https://pubmed.ncbi.nlm.nih.gov/38723450/)
- PRACTICE: Readwise timed 2,074 testers and reported bionic text was 2.6 words per minute slower, with comprehension "virtually identical." Company blog, not peer-reviewed. [Readwise](https://blog.readwise.io/bionic-reading-results/)
- UNVERIFIED: a 2024 Turkish classroom study reported faster reading and comprehension for 6th graders. Its design is a posttest with a control group, and I could not confirm the citation.
- Two Utrecht student theses (speed reading; ADHD readers with EEG) were inconclusive. [Thesis](https://studenttheses.uu.nl/handle/20.500.12932/47156)
- A 2025 eye-tracking study on bionic eye movements exists ([PMC12565662](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12565662/)). I did not open it, so its findings are UNVERIFIED.

### 1.2 RSVP (one word at a time)

- EVIDENCE: Moussaoui, Niemeier and colleagues (2025, *Journal of the International Neuropsychological Society*). Young adults with ADHD read short paragraphs in three conditions: normal, paced word-by-word with layout kept, and RSVP. RSVP gave the clearest comprehension gain. A search summary reported a gain of almost 13 percent; I did not check the comparison group or sample size. [PubMed 41277242](https://pubmed.ncbi.nlm.nih.gov/41277242/), [DOI](https://doi.org/10.1017/S1355617725101628)
- EVIDENCE: Schotter, Tran and Rayner (2014, *Psychological Science* 25(6):1218 to 1226). A trailing-mask paradigm, which mimics RSVP by hiding each word once the eyes pass it, cut comprehension. The effect held for plain and ambiguous sentences. [DOI](https://doi.org/10.1177/0956797614531148)
- EVIDENCE: Rayner, Schotter, Masson, Potter and Treiman (2016, *Psychological Science in the Public Interest*), "So Much to Read, So Little Time." Speed-reading gains come with a comprehension cost. Eye movements take a small share of reading time; word and sentence processing are the bottleneck. [DOI](https://doi.org/10.1177/1529100615625998)
- EVIDENCE: a 2016 PLOS One study on RSVP rate notes that high rates hurt comprehension and cites an optimum near 300 words per minute (Carver, 1992). Title and authors UNVERIFIED. [PLOS One](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0153786)
- **Verdict:** RSVP may help some adults with ADHD on short passages. It hurts regression-dependent readers. Keep it opt-in and give it a jump-back control.

### 1.3 Text-to-speech with highlighting (bimodal reading)

- EVIDENCE: Keelor and colleagues (2023, *Annals of Dyslexia* 73:469 to 486). Ages 8 to 12 with reading difficulties read five passages. TTS with and without highlighting both beat silent reading. Highlighting added nothing over plain TTS. Students with dyslexia alone gained more than those with broader reading and language impairment. DOI 10.1007/s11881-023-00281-9. [PubMed 37119436](https://pubmed.ncbi.nlm.nih.gov/37119436/)
- EVIDENCE: Keelor and colleagues (2020, *Assistive Technology Outcomes and Benefits*). Six passages, including a fast highlighted condition. No difference from the presentation features. [PDF](https://www.atia.org/wp-content/uploads/2020/06/ATOB-V14-A2-Keelor_etal.pdf)
- EVIDENCE: Bonifacci and colleagues (2021, *Computer Assisted Learning*). Students with dyslexia stayed on task more with TTS than with self-paced reading. Audio-only increased mind wandering. Audio plus text did not differ from self-paced reading. [PDF](https://cris.unibo.it/retrieve/160edfa7-6b61-4ca8-816f-813a0a3c6e1a/Computer%20Assisted%20Learning%20-%202021%20-%20Bonifacci%20-%20Text%E2%80%90to%E2%80%90speech%20applications%20to%20reduce%20mind%20wandering%20in%20students%20with.pdf)
- UNVERIFIED: Ikeshita and colleagues (2018) reported easier reading with synchronized highlighting for children with developmental dyslexia. I saw it only second-hand on a [Bookshare page](https://www.bookshare.org/post/bookshares-evidence-based-features-provide-effective-reading-support).
- **Verdict:** TTS is the proven part. Highlighting is an optional layer with no comprehension gain in the best study so far.

### 1.4 Retrieval practice (ADHD and dyslexia)

- EVIDENCE (small samples): Minear and colleagues (2023, *Frontiers in Psychology*). 36 adults with ADHD and 36 controls learned word pairs by restudy or self-test. Everyone gained from testing, and ADHD status did not moderate that gain. Unmedicated participants with ADHD scored lower overall, at encoding and on the final test. DOI 10.3389/fpsyg.2023.1186566. [Frontiers](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1186566/full)
- Earlier studies on ADHD and testing are mixed. Prose-passage work found no testing benefit. A 2023 Frontiers study on free recall for ADHD students recommended whole-text recall with organizing strategies. [Frontiers](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1301726/full)
- Gap: I found no meta-analysis or adult-focused randomized trial for ADHD. I found no retrieval-practice study for dyslexia in this run. Both are UNVERIFIED gaps.

### 1.5 Gamification, streaks and rewards

- EVIDENCE: Deci, Koestner and Ryan (1999, *Psychological Bulletin* 125(6):627 to 668), 128 studies. Engagement-contingent, completion-contingent and performance-contingent rewards reduced free-choice intrinsic motivation (d = -0.40, -0.36, -0.28). Cameron and Pierce (1994) contested this, and the dispute continues. DOI 10.1037/0033-2909.125.6.627. [PubMed 10589297](https://pubmed.ncbi.nlm.nih.gov/10589297/)
- EVIDENCE: Sailer and Homner (2020, *Educational Psychology Review*), meta-analysis. Gamification effects: cognitive g = .49 (k = 19) and motivational g = .36 (k = 16). The cognitive effect held in high-rigor studies. The motivational and behavioral effects were less stable. DOI 10.1007/s10648-019-09498-w. [Springer](https://link.springer.com/article/10.1007/s10648-019-09498-w)
- PRACTICE: I found no peer-reviewed study of streak anxiety or of checking driven by streak counters. Treat as a design risk, not a measured effect.
- **Verdict:** Prominent completion or performance rewards tend to lower intrinsic motivation, and the research on that is contested. Any reward in Polycarp should be informational, with no loss penalties.

### 1.6 Speed reading and skimming

- EVIDENCE: Rayner et al. (2016), above. Skimming gets through text faster with moderate comprehension when deep understanding is not the goal.
- PRACTICE: the APS summary of Rayner et al. reports skimming rates two to four times faster than normal silent reading. Treat the figure as UNVERIFIED until the full paper is read.

---

## Part 2. The twelve groups

### 2.1 ADHD

**(a) Mechanism.** Sustained attention, inhibition and working memory. Reading breaks when mind-wandering or an interruption pulls focus, and re-finding one's place costs effort. NLM describes ADHD as a neurodevelopmental disorder with inattention, hyperactivity and impulsivity; diagnosis requires symptoms in two or more settings. [MedlinePlus ADHD](https://medlineplus.gov/attentiondeficithyperactivitydisorder.html)

**(b) What breaks on the web.** Pop-ups, autoplay, carousels, sidebars, notification badges, long unbroken text, and tabs that compete for attention.

**(c) Design implications.**
- EVIDENCE (W3C COGA, informative): limit interruptions, make short critical paths, avoid too much content. [Limit Interruptions](https://www.w3.org/TR/coga-usable/#limit-interruptions-pattern), [Make Short Critical Paths](https://www.w3.org/TR/coga-usable/#make-short-critical-paths-pattern), [Avoid Too Much Content](https://www.w3.org/TR/coga-usable/#avoid-too-much-content-pattern)
- EVIDENCE (WCAG 2.2.2): give a way to pause, stop or hide moving content that runs longer than five seconds. [Understanding 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide)
- EVIDENCE (small): offer RSVP as an opt-in mode with a jump-back control. [Moussaoui 2025](https://pubmed.ncbi.nlm.nih.gov/41277242/); [Schotter 2014](https://doi.org/10.1177/0956797614531148)
- EVIDENCE (small): add opt-in retrieval prompts at section ends. [Minear 2023](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1186566/full)
- PRACTICE: show no reward popups during a reading session.

**(d) Avoid.** Forced RSVP or any mode that sets the pace for the reader. Timers that advance the next word. Session streaks in the reading view.

### 2.2 Dyslexia

**(a) Mechanism.** The core account is a phonological decoding difficulty. Several visual accounts also matter: visual crowding, where neighboring letters blur together, and a visual attention span deficit that can occur apart from phonology. A 2015 PeerJ meta-analysis of 12 experiments found lower overall accuracy in dyslexia on attentional blink tasks. [PeerJ 2015](https://peerj.com/articles/746) The NLM page on developmental reading disorder could not be read in this run, so its wording is UNVERIFIED.

**(b) What breaks on the web.** Dense blocks, justified text, italics, small or light text, crowded letters on long lines, and decorative fonts.

**(c) Design implications.**
- EVIDENCE: use sans serif, roman (non-italic) faces. Rello and Baeza-Yates (2013, ASSETS, 48 readers with dyslexia, eye-tracked) found sans serif, monospaced and roman faces read better than serif, proportional or italic. Italics were consistently harder. DOI 10.1145/2513383.2513447. [DBLP record](https://dblp.dagstuhl.de/rec/bibtex/conf/assets/RelloB13)
- EVIDENCE: offer OpenDyslexic only as a user choice, not as the fix. In the same study it did not improve or hurt reading, and participants preferred Verdana and Helvetica.
- EVIDENCE (WCAG 1.4.8, AAA): turn off justification and keep lines near 80 characters.
- EVIDENCE (caveat): a crowding-based preset. Joo, White, Strodtman and Yeatman (2018) found a subgroup of adults with dyslexia with higher crowding who read faster with added letter, word and line spacing. Venue and sample size UNVERIFIED; the [Stanford-hosted PDF](https://edneuro.stanford.edu/wp-content/uploads/2021/09/Optimizing-text-for-an-individuals-visual-system.pdf) is the cited copy. Background: [Gori and Facoetti (2015), PubMed 25589292](https://pubmed.ncbi.nlm.nih.gov/25589292/) on crowding and reading; the venue is UNVERIFIED because two summaries disagree.
- EVIDENCE: offer TTS with optional highlight (see 1.3).
- PRACTICE: the BDA Dyslexia Friendly Style Guide (current edition 2023) advises avoiding abbreviations, giving expansions on first use, and providing a glossary. The official BDA page returned a 404 in this run, so the guide's wording is UNVERIFIED on the official site. Secondary copies were found.

**(d) Avoid.** Italics. Forced OpenDyslexic. Justified text. Light or thin text. Claims that bionic bolding helps. Removing regressions. Timed reading.

### 2.3 Visual snow syndrome (VSS)

**(a) Mechanism.** Schankin, Maniyar, Digre and Goadsby (2014, *Brain*) argued visual snow is a disorder distinct from migraine aura. Associated symptoms: palinopsia (afterimages, trails on moving objects), enhanced entoptic phenomena, photophobia and nyctalopia. Tinnitus and migraine co-occur often; one review gives 30 to 60 percent migraine overlap. Klein and Schankin (2021, *Frontiers in Neurology*) reviewed 53 studies and concluded that primary and secondary visual areas show structural, functional and metabolic changes. [PubMed 24645145](https://pubmed.ncbi.nlm.nih.gov/24645145/), [PMC8521005](https://pmc.ncbi.nlm.nih.gov/articles/PMC8521005)
- Caveat: sources disagree on how many extra visual symptoms the diagnosis requires. Check ICHD-3 directly (UNVERIFIED which count it uses).
- Treatment evidence is thin (Current Opinion in Neurology, 2024, [PubMed 38465699](https://pubmed.ncbi.nlm.nih.gov/38465699/)).

**(b) What breaks on the web.** Shimmer or flicker on text, moving backgrounds, scroll-linked effects, palinopsia trails, and bright white backgrounds at night.

**(c) Design implications.**
- EVIDENCE (WCAG 2.2.2 and 2.3.1): stop all moving or flashing content on request.
- EVIDENCE (WCAG 1.4.8 mechanism): let users choose background and text colors and dim the page.
- PRACTICE: a global still mode that halts all animation, including Polycarp's own.
- PRACTICE: no textures, grain, noise or striped overlays behind text.
- PRACTICE: no motion used to show state changes; use a static label.

**(d) Avoid.** Pure white on pure black by default (glare for many people with photophobia, PRACTICE). Striped or checkered backgrounds (see 2.6). Parallax, hover shimmer, auto-advancing text.

### 2.4 OCD (re-reading and checking)

**(a) Mechanism.** Checking is the most reported OCD compulsion (narrative review, 2025, [Psychology Research and Behavior Management](https://www.dovepress.com/the-etiology-assessment-and-treatment-of-compulsive-checking-a-review-peer-reviewed-fulltext-article-PRBM)). Checking is meant to reduce doubt, but it backfires. In van den Hout and Kindt (2003, *Behaviour Research and Therapy* 41:301 to 316), repeated checking of a virtual gas stove made memories less vivid and less detailed and lowered confidence in memory. Actual memory accuracy did not change. DOI 10.1016/S0005-7967(02)00012-8. [DOI](https://doi.org/10.1016/S0005-7967(02)00012-8)
- Later work extended the paradigm (Toffolo and colleagues, 2016; Radomsky, Gilchrist and Dussault, 2006). Venues UNVERIFIED.
- Re-reading compulsions: a consumer description (NOCD) says people re-read sentences or words until it feels right. I found no peer-reviewed reading-specific study. PRACTICE only.
- Exposure and response prevention is the standard behavioral treatment. NICE CG31 was not retrieved in this run (UNVERIFIED).

**(b) What breaks on the web.** Doubt about whether a form saved. Repeated "are you sure" dialogs. Counters that must be read to zero. Unsaved-change warnings that appear again and again. Undo lists the user cannot trust.

**(c) Design implications.**
- EVIDENCE (mechanism) and PRACTICE (UI): show one clear saved or done state and do not repeat it.
- PRACTICE: a visible end-of-section marker, so there is no reason to re-scan.
- PRACTICE: save reading position locally, so the user does not need to re-check where they were.
- PRACTICE: let users turn off re-read counters, confirmation prompts and progress-reset warnings.
- PRACTICE: no streak counters or unfinished-task badges.

**(d) Avoid.** Re-read counters. "Are you sure" on every page. Countdown timers that create urgency. Streak-loss messages. Nudges such as "you may have missed something." Any reward the user must repeat to feel safe.

### 2.5 Autism

**(a) Mechanism.** Differences in sensory processing (overload, reactivity) and in pragmatic and figurative language. Kritsotakis and Morfidi (2025, [PubMed 40980749](https://pubmed.ncbi.nlm.nih.gov/40980749/)) compared autistic children without intellectual disability with typical peers. The autistic group scored lower on reading comprehension, grammar and figurative language, with no gap in receptive vocabulary. The authors link the gap to morphosyntactic and pragmatic processing, not to sensory factors. A 2024 review (Frontiers in Psychiatry) notes that social communication predicts comprehension beyond word recognition.

**(b) What breaks on the web.** Flashing, autoplay, moving carousels, animated backgrounds, layouts that change without warning, idioms and metaphor labels, and decorative symbols with no meaning.

**(c) Design implications.**
- EVIDENCE (COGA, informative): use literal language. [4.4.4 Use Literal Language](https://www.w3.org/TR/coga-usable/#use-literal-language-pattern); supported by Kritsotakis and Morfidi 2025.
- EVIDENCE (COGA, informative): do not move controls or content unexpectedly ([4.5.1](https://www.w3.org/TR/coga-usable/#ensure-controls-and-content-do-not-move-unexpectedly-pattern)) and let users control when content moves ([4.9.1](https://www.w3.org/TR/coga-usable/#let-users-control-when-the-content-moves-or-changes-pattern)).
- EVIDENCE (COGA scenario, informative): avoid abstract imagery and metaphors. [Amy scenarios](https://www.w3.org/TR/coga-usable/#amy-an-autistic-computer-scientist)
- PRACTICE: honor the reduced-motion preference in the operating system by default.
- UNVERIFIED gap: I found no study linking sensory load to reading text. The Poulsen et al. review covers auditory sensory overload, not reading.

**(d) Avoid.** Idioms and metaphors in labels. Decorative animation. Surprise pop-ups. Auto-advance. Playful copy built on sarcasm or wordplay. Sudden color or font changes mid-document.

### 2.6 Migraine and photosensitivity

**(a) Mechanism.** Two separate risks. Photosensitive seizures are triggered by flashes, and WCAG 2.3.1 sets the thresholds. Migraine and visual stress are linked to pattern glare. A 2006 study found more illusions and more pattern glare in people with migraine (PubMed 17040340; authors and venue UNVERIFIED). A review of the Pattern Glare Test set cutoffs and flagged migraine and Meares-Irlen syndrome as prone (PubMed 18565084; venue UNVERIFIED). A 2025 study of 1,248 undergraduates found pattern glare in 23.6 percent (Frontiers in Human Neuroscience, UNVERIFIED citation details).

**(b) What breaks on the web.** Flashing banners, strobe-like loaders, striped or busy backgrounds, auto-scroll, parallax and fast carousels.

**(c) Design implications.**
- EVIDENCE (WCAG 2.3.1): no more than three flashes in any second, and no flash that meets the luminance-change rule (20 cd/m2 or more where the darker image is below 160 cd/m2, per the Understanding page). WCAG 2.2 adds a rule for saturated red flashes. [Understanding 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)
- EVIDENCE (WCAG 2.2.2): pause, stop or hide moving elements over five seconds.
- EVIDENCE (small, caveat): tints. A 2015 study of 95 young adults (Frontiers in Psychology) found that people who benefited from colored overlays read faster with them, and the authors linked the benefit to reduced pattern glare. [Frontiers 2015](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.01651/full). Benefit held only for some readers.
- PRACTICE: offer a user-set background tint. Do not overlay the page by default.
- PRACTICE: static layouts only, with no parallax or scroll-linked animation.

**(d) Avoid.** Strobing indicators. Stripes behind text. Auto-advance carousels. Flicker at refresh. Forced tints. High-contrast white on black as the default.

### 2.7 Concussion and TBI (reading fatigue)

**(a) Mechanism.** Mild TBI can impair eye movements. In chronic concussion, King-Devick reading showed longer pauses between saccades, more saccades and less accurate endpoints; the authors suggested the slowing may be partly cognitive ([PMC5048390](https://pmc.ncbi.nlm.nih.gov/articles/PMC5048390)). In 30 people with TBI and 60 controls, reading eye-movement measures were lower in the TBI group ([PMC7301197](https://pmc.ncbi.nlm.nih.gov/articles/PMC7301197)). A structured review found that many studies poorly report demographics and time since injury ([PMC7739790](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7739790/)). A crossover trial of six weeks of oculomotor training improved reading rate in 12 adults with mTBI ([PubMed 24284470](https://pubmed.ncbi.nlm.nih.gov/24284470/); authors UNVERIFIED).
- Fatigue specifically: a vision-therapy trial in 28 mTBI patients used the MFI-20 fatigue inventory ([PubMed 34781837](https://pubmed.ncbi.nlm.nih.gov/34781837/)). I read only the methods, not the fatigue results.
- Gap: no study I found links reading fatigue to RSVP, bionic text or TTS in TBI (UNVERIFIED).

**(b) What breaks on the web.** Horizontal scrolling, long lines, sticky headers and sidebars, auto-moving content, dense columns, and low-contrast text that tires the eye.

**(c) Design implications.**
- EVIDENCE (WCAG 1.4.10): reflow at 320 CSS pixels with no two-dimensional scrolling for text.
- EVIDENCE (WCAG 1.4.8): keep lines near 80 characters.
- EVIDENCE (WCAG 1.4.12): keep text usable at the spacing values in the Understanding page (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em). Content need not use them; it must survive them.
- EVIDENCE (WCAG 1.4.10 Understanding): make sticky or fixed sidebars static at small widths.
- PRACTICE: a visible session-length cue and an optional break, never a forced break.

**(d) Avoid.** RSVP as a default for this group, since it removes regressions and lowers comprehension for regression-dependent readers (Schotter 2014; Rayner 2016), and nothing shows it eases fatigue. Horizontal carousels. Animated loaders. Flashing.

### 2.8 Older adults (presbyopia, contrast loss, slower processing)

**(a) Mechanism.** Age-related losses in low- and high-frequency contrast sensitivity predict slower reading at large and small character sizes (Akutsu, Legge and colleagues, 1991, "Psychophysics of reading X," [Legge lab PDF](https://legge.dl8.umn.edu/sites/legge.psych.umn.edu/files/2020-08/psychophysics_of_reading._x._effects_of_age_related_changes_in_vision_akutsu_legge_ross_schuebel_1991.pdf); [PubMed 1940088](https://pubmed.ncbi.nlm.nih.gov/1940088/), abstract not opened). Presbyopia reduces accommodation; Teramoto and colleagues (2012) used RSVP with Japanese text to isolate its effect in middle-aged readers ([PDF](https://www.gsais.kyoto-u.ac.jp/staff/sekiyama/research_paper/Teramoto_et%20al%202012%20AP&P.pdf); venue from the file name, UNVERIFIED). Text contrast affects older readers more than younger ones (Mitzner and Rogers, 2006, as summarized in a later paper; UNVERIFIED venue). Faint text disrupts eye movements more for older adults (UNVERIFIED citation).

**(b) What breaks on the web.** Small fonts, thin light-gray text, low-contrast buttons, fixed-height boxes that clip text when enlarged, form timeouts, dense multi-column pages, and auto-advance.

**(c) Design implications.**
- EVIDENCE (WCAG 1.4.4 and 1.4.12): users can enlarge text without losing content or function.
- EVIDENCE (WCAG 1.4.3): raise contrast for body text; criterion text not fetched this run (see Part 3).
- EVIDENCE (COGA, informative): avoid timeouts and data loss, [4.5.9](https://www.w3.org/TR/coga-usable/#avoid-data-loss-and-timeouts-pattern), and let users control pace, [4.9.1](https://www.w3.org/TR/coga-usable/#let-users-control-when-the-content-moves-or-changes-pattern).
- EVIDENCE (WCAG 1.4.8): offer a larger-spacing preset.
- PRACTICE: do not default to RSVP. The Teramoto design is a research tool, not a reader preset.

**(d) Avoid.** Light-gray text, auto-scroll, fixed-pixel containers, clipped text in buttons, and time-limited reading.

### 2.9 Low vision

**(a) Mechanism.** Reading speed tracks the visual span, which shrinks with low vision. Size and contrast both set reading speed (Legge and colleagues, 2007, "The case for the visual span as a sensory bottleneck in reading," [UMN PDF](https://legge.dl8.umn.edu/sites/legge.psych.umn.edu/files/2020-08/Legge%20Cheung%20Yu%20Chung%20Lee%20Owens%202007%20The%20case%20for%20the%20visual%20span%20as%20a%20sensory%20bottleneck%20in%20reading.pdf)). The foundational Legge psychophysics of reading series (1985) is in the WCAG 1.4.8 reference list, which I read.

**(b) What breaks on the web.** Text on photos, thin weights, low contrast, text that breaks past 200 percent, hidden zoom controls, custom cursors, fixed-height boxes.

**(c) Design implications.**
- EVIDENCE (Legge, "Psychophysics of reading XI"): luminance contrast worked better than color contrast for low-vision readers of 6-degree characters. Details beyond the search summary are UNVERIFIED. [PDF](https://legge.dl8.umn.edu/sites/legge.psych.umn.edu/files/files/media/legge90_psychophysics_of_reading._xi._comparing_luminance_and_color_contrast.pdf)
- EVIDENCE (Mansfield, Legge and Bane, "Psychophysics of Reading XV"): Courier had small advantages over Times near the acuity limit. Year and venue UNVERIFIED.
- EVIDENCE (WCAG 1.4.8 and 1.4.10): user-set size and reflow.
- PRACTICE: keep text as text, not as images.

**(d) Avoid.** Text over photos, color-only contrast, fixed pixel layouts, thin weights, and hidden scrollbars.

### 2.10 Second-language readers

**(a) Mechanism.** Comprehension depends on word recognition speed and executive control. Adolescent L2 readers' ability to notice and repair comprehension breaks depends on word-processing difficulty and executive control (2022, *Reading and Writing*, [link](https://link.springer.com/article/10.1007/s11145-022-10269-3); authors UNVERIFIED). Tywoniw (2023, *Frontiers in Communication*, 102 readers) found fixation efficiency matters, and motivation and reasoning can compensate ([DOI 10.3389/fcomm.2023.1176986](https://doi.org/10.3389/fcomm.2023.1176986)). Listening while reading gave a marginal gain on high-load passages (Kim, 2020, *JSLAT*; UNVERIFIED citation).

**(b) What breaks on the web.** Idioms, jargon, long nested sentences, cultural references in microcopy, machine translation that hides the source, and fast audio.

**(c) Design implications.**
- EVIDENCE (COGA, informative): [4.4.1 Use Clear Words](https://www.w3.org/TR/coga-usable/#use-clear-words-pattern), [4.4.2 Use a Simple Tense and Voice](https://www.w3.org/TR/coga-usable/#use-a-simple-tense-and-voice-pattern).
- EVIDENCE (COGA, informative): [4.4.8 Provide Summary of Long Documents and Media](https://www.w3.org/TR/coga-usable/#provide-summary-of-long-documents-and-media-pattern).
- EVIDENCE (small, mixed): listen-while-read is an option, not a default.
- PRACTICE: show the original text next to any translation.
- PRACTICE: keep the reader's place when switching between text and audio.

**(d) Avoid.** Idioms and cultural references in microcopy. Machine translation that replaces the source. Forced fast TTS.

### 2.11 Anxiety and depression (concentration)

**(a) Mechanism.** Attentional control theory: anxiety disrupts attentional control and can also raise effort. A 2024 study of 251 students found that anxiety's effect on reading depends on its form; mediation is still to be confirmed (UNVERIFIED citation). In struggling readers in grades four and five, anxiety tracked comprehension more closely than basic reading skill (UNVERIFIED citation). Poor sleep links mood to concentration (UNVERIFIED citation).

**(b) What breaks on the web.** Time pressure, red badges, leaderboards, streak losses, notifications, infinite feeds, and comparison.

**(c) Design implications.**
- EVIDENCE (small, preliminary): a 2025 randomized study of college students with higher anxiety and depression found that two of its reading formats (names UNVERIFIED) improved cognition and mood, electronic reading gave modest benefits, and the control group did not improve. Self-report scales only. [Frontiers in Psychology](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1437790/full)
- PRACTICE: no timers, time pressure or streak losses.
- PRACTICE: user controls over pace, with progress shown without comparison.
- EVIDENCE (COGA, informative): [4.6.1 Limit Interruptions](https://www.w3.org/TR/coga-usable/#limit-interruptions-pattern) for a quiet reading view.

**(d) Avoid.** Timers. Streak penalties. Loss messages. Leaderboards. "You're falling behind" copy. Mood prompts inside the reading view.

### 2.12 General population (skimming on the web)

**(a) Mechanism.** Web readers scan. NN/g's eye-tracking reports an F-shaped scan (first described in 2006; 2017 update with 232 users). The pattern is default when text has no cues. [NN/g](https://www.nngroup.com/articles/F-shaped-pattern-reading-web-content/). This is industry research, so PRACTICE.

**(b) What breaks on the web.** Unbroken paragraphs, no headings, key information buried, and speed claims that promise more than they deliver.

**(c) Design implications.**
- PRACTICE (NN/g): put the key information in the first two paragraphs.
- EVIDENCE (COGA, informative): [4.3.3 Use a Clear and Understandable Page Structure](https://www.w3.org/TR/coga-usable/#use-a-clear-and-understandable-page-structure-pattern).
- EVIDENCE (Acta Psychologica 2024; Rayner et al. 2016): make no speed or comprehension claim for bionic or RSVP modes.
- EVIDENCE (Rayner et al. 2016): a gist or skim mode is fine if it is labeled as a trade-off, not the default.

**(d) Avoid.** "Read twice as fast" claims. Forced RSVP. Bionic reading presented as universal.

---

## Part 3. Items checked and not verified

- WCAG 1.4.3 Contrast (Minimum) and 1.4.4 Resize Text: not fetched this run. The 4.5 to 1 and 3 to 1 ratios come from the standard; verify on the [Understanding page](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- WCAG 1.4.8 and 1.4.10 verified on the W3C Understanding pages.
- COGA design patterns verified on the W3C Note (pattern names and anchors). The Note is informative, not normative.
- BDA 2023 style guide: official page returned 404; wording UNVERIFIED.
- NIH: MedlinePlus ADHD verified. No MedlinePlus page for visual snow or OCD was found; the dyslexia page could not be read.
- Joo, White, Strodtman and Yeatman (2018): venue and sample size UNVERIFIED. The 2018 crowding-subgroup finding is from a search summary.
- Gori and Facoetti (2015): PubMed 25589292; venue conflicting between two summaries.
- Akutsu et al. (1991), Teramoto et al. (2012), Mitzner and Rogers (2006): found through search; venues and details partly UNVERIFIED.
- Legge 1990 and Mansfield et al. (year): details from search summaries.
- Kim (2020), Ikeshita (2018), Toffolo (2016), Radomsky et al. (2006), Schneps et al. (2013), Turkish TTS study (2024), Frontiers anxiety formats 2025: UNVERIFIED in detail.
- Dyslexia retrieval practice and adult ADHD meta-analysis: not found.
- Reading sensory overload in autism: not found.
- Reading fatigue with RSVP or bionic text in TBI: not found.
- Streak anxiety effects: not found in peer-reviewed sources.
- Rayner et al. (2016) skim-rate figure (two to four times faster): from an APS summary; UNVERIFIED from the full paper.
- Keelor 2020 and 2023 verified via search summaries and the PubMed record for 2023.

---

## Part 4. Design rules for Polycarp

1. Make no speed or comprehension claim for bionic bolding; keep it an opt-in style [EVIDENCE: Acta Psychologica 2024, PubMed 38723450].
2. Default to a roman, non-italic sans serif, and let users choose any installed font [EVIDENCE: Rello and Baeza-Yates 2013].
3. Offer OpenDyslexic only as a user choice; it gave no reading benefit in that study [EVIDENCE: Rello and Baeza-Yates 2013].
4. Never remove regressions; any RSVP mode needs a jump-back control and a way to return to the page [EVIDENCE: Schotter, Tran and Rayner 2014].
5. RSVP is off by default, opt-in, and labeled as a speed trade-off [EVIDENCE: Moussaoui et al. 2025 (small); Rayner et al. 2016].
6. Synchronized highlight is an option on top of plain TTS; plain TTS is the proven part [EVIDENCE: Keelor et al. 2023].
7. Let users set size, line spacing, paragraph spacing, width and both colors; never override the site's settings without consent [EVIDENCE: WCAG 1.4.8 (AAA) and 1.4.12 (AA)].
8. Cap reading width near 80 characters and turn off justification [EVIDENCE: WCAG 1.4.8 (AAA)].
9. Keep body text contrast at least 4.5 to 1 and offer a higher-contrast setting [EVIDENCE: WCAG 1.4.3 (text not fetched this run)].
10. Never flash more than three times per second or exceed the 2.3.1 luminance and red-flash limits [EVIDENCE: WCAG 2.3.1].
11. Pause, stop or hide any moving element that runs over five seconds, including Polycarp's own animation [EVIDENCE: WCAG 2.2.2].
12. Reflow reading text at 320 CSS pixels with no two-dimensional scroll [EVIDENCE: WCAG 1.4.10].
13. Offer a crowding-spacing preset for users who report blurred letters, labeled as a preset and not a diagnosis [EVIDENCE: Joo et al. 2018 (subgroup, venue UNVERIFIED); Gori and Facoetti 2015].
14. No timers, timeouts, auto-advance or auto-scroll in any reading flow [EVIDENCE: COGA 4.5.9; WCAG 2.2.2].
15. Rewards are informational: no streak losses, no leaderboards, no badge that demands a response [EVIDENCE: Deci et al. 1999 (contested); Sailer and Homner 2020 (motivational gain less stable)].
16. Retrieval prompts are opt-in, short, placed at section ends and never scored publicly [EVIDENCE: Minear et al. 2023 (small samples)].
17. Write Polycarp's own UI and any simplified text in literal, plain sentences [EVIDENCE: COGA 4.4.4; Kritsotakis and Morfidi 2025].
18. Every mode switch keeps the reader's place, so the user can return to normal reading at the same word [EVIDENCE: COGA 4.5.2 (informative); WCAG 1.4.8 intent on losing the reading place].
19. Provide a still, low-glare, no-stripe mode with a visible toggle and no textured backgrounds [PRACTICE: visual snow and migraine community guidance; Schankin et al. 2014 defines symptoms, not treatments].
20. Show one clear saved or done state and never ask the user to re-read or re-confirm to check [EVIDENCE: van den Hout and Kindt 2003].

---

## Part 5. Source links

- W3C COGA Note: https://www.w3.org/TR/coga-usable/
- WCAG 2.2 Understanding: https://www.w3.org/WAI/WCAG22/Understanding/ (visual-presentation, reflow, pause-stop-hide, three-flashes-or-below-threshold, text-spacing)
- NIH NLM MedlinePlus ADHD: https://medlineplus.gov/attentiondeficithyperactivitydisorder.html
- Moussaoui et al. 2025: https://doi.org/10.1017/S1355617725101628
- Schotter et al. 2014: https://doi.org/10.1177/0956797614531148
- Rayner et al. 2016: https://doi.org/10.1177/1529100615625998
- Keelor et al. 2023: https://doi.org/10.1007/s11881-023-00281-9
- Rello and Baeza-Yates 2013: https://doi.org/10.1145/2513383.2513447
- Minear et al. 2023: https://doi.org/10.3389/fpsyg.2023.1186566
- Deci et al. 1999: https://doi.org/10.1037/0033-2909.125.6.627
- Sailer and Homner 2020: https://doi.org/10.1007/s10648-019-09498-w
- van den Hout and Kindt 2003: https://doi.org/10.1016/S0005-7967(02)00012-8
- Schankin et al. 2014: https://pubmed.ncbi.nlm.nih.gov/24645145/
