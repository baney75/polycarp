# Polycarp: visual research on typography and color for reading

Date: 2026-11-20. Status: prepared (written from a search pass, not from full-text reads of every paper).

## How this was checked

- The scholarly index (academic_search) returned no results for its later queries in this pass, so most checks used WebSearch against publisher pages, DOI records, PubMed records and secondary summaries.
- Citations were checked for existence and title against a DOI, PubMed or publisher record where a record was returned.
- Anything marked UNVERIFIED was seen only in a secondary summary, or not seen at all. Do not cite UNVERIFIED numbers without reading the primary paper.
- Two corrections to the brief: Evans and Allen (2016) is in the Journal of Optometry, not Ophthalmic & Physiological Optics. Wery and Diliberto (2017) tested OpenDyslexic, not Dyslexie. The Dyslexie study is Kuster et al.

## Evidence strength labels

- STRONG: several independent studies or a meta-analysis agree.
- MODERATE: one or two good studies, or consistent but small effects.
- WEAK: single study, secondary-only, or small or mixed.
- AGAINST: evidence contradicts the claim.

## Bottom line

- Best-fit beats best font. Individual best fonts vary widely, and no single family wins for everyone [WAL22, KAD21].
- Size, contrast and letter spacing are the best-supported visual levers, especially for low vision and dyslexia [LEG11, ZOR12, BER01].
- Several popular features do not hold up: bionic bolding, disfluent "desirable difficulty" fonts, Irlen-style colored overlays, blue-light glasses, and RSVP for ordinary readers.
- Light text on a dark background is slower under normal lighting. Dark mode is a comfort option, not a reading gain.

---

## 1. Serif vs sans-serif

- WAL22 (Wallace et al. 2022, ACM TOCHI, https://doi.org/10.1145/3502222). Crowdsourced online study, hundreds of participants (exact N UNVERIFIED). Reading speed in words per minute differed by 35% between each reader's fastest and slowest font, with no loss of comprehension. Best font varied across readers: "one font does not fit all." Font size was normalized by perception. Replicated across individuals in KAD21 and DAY24 (different lab for KAD21).
- DAY24 (Day, Atilgan, Giroux, Sawyer 2024, Education Sciences 14(8):854, https://doi.org/10.3390/educsci14080854). 51 students in grades 3 to 5, four serif and four sans fonts. Roboto and Arial were read fastest at group level. Individual best-to-worst font gaps were significant. Sawyer also co-authored WAL22, so this is not an independent group.
- BER01 (Bernard, Liao, Mills 2001, CHI '01 Extended Abstracts, https://doi.org/10.1145/634067.634173). Older adults. 14-point text was rated more legible than 12-point. 12-point serif reading time was significantly longer than 14-point serif or sans. Participants preferred 14-point. Sample detail UNVERIFIED (a related study reported mean age about 70).
- MIL01 (Mills, Peterson, Storrer 2001, Usability News). Secondary only: serif read faster at 14 point, sans preferred. UNVERIFIED primary.
- ARD05 (Arditi and Cho 2005, Vision Research, https://doi.org/10.1016/j.visres.2005.06.013). Title confirmed. Findings NOT retrieved, so do not cite a direction for it.
- RIC22 (Richardson 2022, SpringerBriefs in Education, https://doi.org/10.1007/978-3-030-90984-0). Review chapter on legibility of letters and words. Notes early work focused on letter confusions. Not a meta-analysis.
- Verdict: serif vs sans main effects are small or absent at matched size. Individual variation is larger than the family effect. No meta-analysis of serif vs sans for screens was found in this pass.
- Design: let readers choose. Do not claim serif or sans is more legible.

## 2. Font size, x-height, letter and word spacing, crowding, line spacing

- LEG11 (Legge and Bigelow 2011, Journal of Vision 11(5):8, https://doi.org/10.1167/11.5.8). Review of print size and reading. Secondary summaries say the fluent range spans about a tenfold x-height range, roughly 0.2 to 2 degrees, and that critical print size in central vision is about 0.2 degrees x-height. Those numbers are UNVERIFIED against the primary text.
- CHU98 (Chung, Mansfield, Legge 1998, Vision Research, https://doi.org/10.1016/s0042-6989(98)00072-8). Print size and reading speed in normal peripheral vision. Title confirmed; findings not read.
- PEL04 (Pelli, Palomares, Majaj 2004, Journal of Vision 4(12):1136-1169, https://doi.org/10.1167/4.12.12). Crowding is unlike ordinary masking. Crowding affects identification but not detection. Critical spacing scales with eccentricity, so crowding dominates in the periphery.
- PEL08 (Pelli and Tillman 2008, Nature Neuroscience 11(10):1129-1135, https://doi.org/10.1038/nn.2187). "The uncrowded window of object recognition." Recognition fails for objects inside the critical spacing of neighbors, which limits reading and search speed. Replicates the crowding account in the wider literature.
- ZOR12 (Zorzi et al. 2012, PNAS, https://doi.org/10.1073/pnas.1205566109). Extra-large letter spacing improved text reading on the fly, without training, in a large unselected sample of Italian and French dyslexic children. Mechanism proposed: dyslexic readers are abnormally affected by crowding. Sample count reported as 74 children aged 8 to 14 in one secondary summary (UNVERIFIED).
- SJO16 (Sjoblom, Eaton, Stagg 2016, British Journal of Educational Psychology, https://doi.org/10.1111/bjep.12127). Letter spacing and colored overlays in adults with dyslexia. Its introduction calls the overlay evidence contradictory. Spacing results UNVERIFIED.
- STA21 (Stagg and Kiss 2021, Research in Developmental Disabilities, https://doi.org/10.1016/j.ridd.2021.104065). Extra-large spacing and overlays in adolescents with dyslexia. Results UNVERIFIED.
- PER12 (Perea, Panadero, Moret-Tatay, Gomez 2012, Learning and Instruction). Children, including developmental dyslexics. Default spacing vs increased spacing (+1.2). Results UNVERIFIED.
- PG12 (Perea and Gomez 2012, PLoS ONE, "Subtle increases in interletter spacing facilitate the encoding of words during normal reading"). Adult skilled readers. Title confirmed; results from title only. A companion paper in Psychonomic Bulletin and Review (2012) reports the same direction for adults (secondary, UNVERIFIED).
- WAL22b (Wallace, Dobres, Bylinskii, Sawyer 2022, Journal of Vision 22(14):3349, "Space for readability: effects on reading speed from individuated character and word spacing"). Individual spacing settings change reading speed. Effect size UNVERIFIED.
- WCAG 1.4.12 values (W3C Understanding SC 1.4.12, https://www.w3.org/WAI/WCAG22/Understanding/text-spacing): line height 1.5, paragraph spacing 2 times font size, letter spacing 0.12em, word spacing 0.16em. These are a test procedure for user overrides. The document does not present them as measured optima, and I did not find the empirical source for the numbers (UNVERIFIED).
- Verdict: size, crowding and the uncrowded-window account replicate. Extra letter spacing helps some dyslexic children (one lab, partly contested in adults). No primary study on line spacing was pulled. Treat WCAG 1.4.12 as an override ceiling, not an optimum.
- Design: expose size, letter spacing, word spacing and line height as user controls. Use the WCAG values as the upper bound of the test range.

## 3. Line length and characters per line

- DYS01 (Dyson and Haselgrove 2001, International Journal of Human-Computer Studies 54(4):585-612). Tested 55 to 100 characters per line. A 2006 usability paper reports, as a secondary summary, that line length in that range did not change reading speed in their comprehension task (UNVERIFIED primary). The same literature separates faster reading from accurate recall.
- DYS98 (Dyson and Kipping 1998, Lecture Notes in Computer Science, https://doi.org/10.1007/bfb0053278). Layout and reading from screen. Findings UNVERIFIED.
- Popular rules, not evidence: "about 66 characters" and "60 characters" (general typographic guidance). No primary source found that sets an optimum.
- A popular book summary states that people read faster with longer lines but prefer shorter ones (UNVERIFIED primary).
- Shaikh (2006) was searched for and not found in this pass. Do not cite.
- Verdict: WEAK. On screen, lines up to about 100 characters do not clearly slow reading. Preference favors shorter lines.
- Design: default to about 60 to 75 characters. Let readers widen to about 100.

## 4. Polarity, color, contrast, dark mode, blue light

Polarity:
- BUC09 (Buchner, Mayr, Brandt 2009, Ergonomics, https://doi.org/10.1080/00140130802641635). The positive polarity advantage (dark text on light) disappeared when overall display luminance was equated. Effect follows luminance, not polarity itself.
- PIE14b (Piepenbrock, Mayr, Buchner 2014, Ergonomics, https://doi.org/10.1080/00140139.2014.948496). Positive polarity gave smaller pupils and better proofreading. Consistent with the luminance hypothesis.
- PIE13 (Piepenbrock, Mayr, Mund, Buchner 2013, Ergonomics, https://doi.org/10.1080/00140139.2013.790485). Positive polarity advantage in both younger and older adults on acuity and proofreading. Sample sizes UNVERIFIED.
- PIE14a (Piepenbrock, Mayr, Buchner 2014, Human Factors, PubMed 25141597, https://pubmed.ncbi.nlm.nih.gov/25141597/). The positive polarity advantage is larger at small character sizes (8 to 14 point tested).
- Replication: the same group ran all of these. No independent replication of the luminance mechanism was found in this pass.

Dark mode and astigmatism:
- No controlled study of dark mode and astigmatism was found. Popular sources say light text on dark smears for astigmatic readers. That is a plausible mechanism, not a measured result (UNVERIFIED).
- Popular sources cite a 2013 Ergonomics study and a 2017 Applied Ergonomics study favoring light mode. Both UNVERIFIED.
- Verdict: AGAINST dark mode as a reading-speed gain under normal light. WEAK for comfort in dim rooms. No evidence found that dark mode protects eyes.

Contrast:
- WCAG 1.4.3 (W3C Understanding SC 1.4.3, https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum). 4.5:1 for body text at AA. The basis is compensation for contrast-sensitivity loss at about 20/40 acuity, starting from a 3:1 baseline in ISO 9241-3 and ANSI/HFES 100. Basis is a sensitivity calculation, not a reading-speed study. Ratios are not rounded: 4.499:1 fails.

Background color:
- REL17 (Rello and Bigham 2017, ASSETS '17, pp. 72-80, https://doi.org/10.1145/3132525.3132546). Ten background colors. Warm colors (peach, orange, yellow) improved reading performance over cool colors (blue, blue-grey, green). Secondary summaries report 341 participants, 89 with dyslexia (UNVERIFIED). The finding is warm vs cool, not "pastel." Independent replication not found.
- Cream vs pure white: no study found (UNVERIFIED). The luminance finding (BUC09) suggests keeping background bright, since a dimmer background cuts performance. That is my inference, not a tested result.

Blue light:
- CHA15 (Chang, Aeschbach, Duffy, Czeisler 2015, PNAS 112(4):1232-1237, https://pubmed.ncbi.nlm.nih.gov/25535358/). 12 adults, two weeks, reading an eReader vs a printed book before bed. The eReader condition showed longer sleep onset, lower melatonin, later circadian timing and reduced next-morning alertness. The authors attribute it to short-wavelength light. The device and light setting are confounded, and the sample is small. PNAS commentary argues the lab conditions overstate it (secondary).
- COC23 (Cochrane review CD013244, 2023, https://www.cochrane.org/CD013244). 17 randomized trials. Blue-light filtering lenses probably give no short-term reduction in eye strain from computer work. Sleep evidence very low certainty. Search ended March 2022.
- Verdict: AGAINST blue-light glasses for eye strain. MODERATE that evening screen light can shift sleep in a lab setting. Not shown for daytime reading.

## 5. Colored overlays, tinted lenses, Irlen

- GRI16 (Griffiths, Taylor, Henderson, Barrett 2016, Ophthalmic and Physiological Optics 36(5):519-544, https://doi.org/10.1111/opo.12316). Systematic review of 51 items (54 datasets) with the Cochrane risk-of-bias tool. Effects generally small or similar to placebo. Cannot endorse colored lenses or overlays for reading difficulties.
- EVA16 (Evans and Allen 2016, Journal of Optometry 9(4):205-218, https://doaj.org/article/0c1d9e49b74740cda05af8e9144e28d2). Systematic review of controlled trials on visual stress using Intuitive Overlays or the Intuitive Colorimeter. Argues that about 20% of dyslexic readers may have visual stress, and that individually prescribed filters may help those people, though not dyslexia itself. The Griffiths group disputes that it is a true systematic review (letter at https://pmc.ncbi.nlm.nih.gov/articles/PMC5484786).
- EVA16L (Evans 2016, Ophthalmic and Physiological Optics, https://doi.org/10.1111/opo.12330). Commentary defending positive findings. Not evidence in itself.
- RIT11 (Ritchie, Della Sala, McIntosh 2011, Pediatrics 128:e932-e938). Title "Irlen colored overlays do not alleviate reading difficulties." Confirmed only from a reference list. Design UNVERIFIED.
- Verdict: AGAINST Irlen-style diagnosed overlays as a reading remedy. WEAK and contested for a visual-stress subgroup.
- Design: an optional, user-chosen tint with no clinical claim.

## 6. Disfluency and "desirable difficulty" fonts

- DIE11 (Diemand-Yauman, Oppenheimer, Vaughan 2011, Cognition, https://doi.org/10.1016/j.cognition.2010.09.012). Original claim that a hard-to-read font improved educational outcomes. Font names and sample sizes UNVERIFIED. This is the source of the popular claim.
- TAY20 (Taylor, Sanson, Burnell, Wade, Garry 2020, Memory, https://doi.org/10.1080/09658211.2020.1758726). Four experiments replicating the creators' Sans Forgetica claims. Participants rated Sans Forgetica harder to read, but it did not improve memory compared with Arial.
- GEL20 (Geller, Davis, Peterson 2020, OSF preprint, https://doi.org/10.31234/osf.io/ku5bz). Three preregistered experiments. Experiment 1 (N = 233): generation effect reliable, no Sans Forgetica benefit. Experiment 2 (N = 528): no Sans Forgetica benefit against highlighting or control. Peer-review status UNVERIFIED.
- XIE18 (Xie and colleagues 2018, meta-analysis; full author list and journal UNVERIFIED). 39 experiments from 25 articles. Overall effect of disfluent fonts on memory trivial, plausibly zero.
- EPR20 (reproducibility commentary, Educational Psychology Review 2020, https://doi.org/10.1007/s10648-020-09579-1; title UNVERIFIED). Says the meta-analysis meets reporting norms but misreports some figures.
- Verdict: AGAINST disfluent fonts for learning. The original effect did not survive replication, and the meta-analysis is near zero.

## 7. Bionic reading and fixation-guided formatting

- SNE24 (Snell 2024, Acta Psychologica, https://doi.org/10.1016/j.actpsy.2024.104304; PMID 38723450). 100 paragraphs, Bionic (word starts bolded) vs normal. No significant difference in reading time. Sample size conflicts across secondary summaries (32, 42 to 90) and must be checked in the paper. Also tested a middle-of-word bolding control (UNVERIFIED details).
- 2025 studies (all from secondary summaries; primaries UNVERIFIED):
  - BIO25a: registered report in Royal Society Open Science. About 90 skilled adult readers after exclusions, mean age 22.9 (summary). Start-bolded text did not change gaze duration. Bolding pulled the first fixation toward the word start only for eight-letter words, and not for four-letter words. Authors and exact date UNVERIFIED.
  - BIO25b: Beelders, Journal of Eye Movement Research, October 2025 (summary). No significant change in fixation durations, fixation count or reading speed.
  - "Guiding the Gaze: How Bionic Reading Influences Eye Movements," PMC12565662 (title seen; findings UNVERIFIED).
- Theory: O'Regan (1990), "Eye movements and reading," Reviews of Oculomotor Research 4, pp. 395-453. O'Regan and Jacobs (1992), Journal of Experimental Psychology: Human Perception and Performance 18(1):185-197. Words are recognized fastest from a fixation near an "optimal viewing position." Secondary summary of O'Regan: about 20 ms recognition cost per letter off that position (UNVERIFIED primary). Brysbaert and Nazir (2005, Journal of Research in Reading) place the optimal position between the word start and middle in left-to-right text.
- Rayner landing-position work: not retrieved in this pass (UNVERIFIED).
- Verdict: the optimal-viewing-position effect is well established. The claim that bolding word starts speeds reading is not supported. AGAINST as a speed feature.
- Design: do not present fixation-guided bolding as a speed feature. If offered, label it as a visual preference only.

## 8. Dyslexia fonts, Lexend, Atkinson Hyperlegible

- WER17 (Wery and Diliberto 2017, Annals of Dyslexia, online 2016, https://doi.org/10.1007/s11881-016-0127-1). Tested OpenDyslexic (not Dyslexie) on reading rate and accuracy in elementary students with dyslexia. Direction and size UNVERIFIED.
- KUS17 (Kuster, van Weerdenburg, Gompel, Bosman, Annals of Dyslexia, online 2017, https://doi.org/10.1007/s11881-017-0154-6). "Dyslexie font does not benefit reading in children with or without dyslexia." The brief's year (2018) probably matches print (UNVERIFIED).
- FRA19 (Franzen, Stark, Johnson 2019, Annals of Eye Science, AB004, https://doi.org/10.21037/aes.2019.ab004). OpenDyslexic improved visual processing and comprehension in adults with dyslexia. Conference abstract, abstract only. WEAK.
- Lexend: no peer-reviewed independent study found. A doctoral study by Shaver-Troup (UNVERIFIED) is reported in secondary summaries with about 20 third graders and oral-fluency gains. Developer claims about comprehension are not independent. WEAK.
- Atkinson Hyperlegible (Braille Institute): design rationale only. A 2024 CSUN session described a low-vision study without reported figures. No primary found. UNVERIFIED.
- Verdict: AGAINST dedicated dyslexia fonts as a general fix (KUS17 for Dyslexie). WEAK for OpenDyslexic, Lexend and Atkinson. Individual preference may still matter (WAL22 logic).

## 9. Justified vs ragged-right, hyphenation, italic, underline, all caps

Justified vs ragged-right:
- TUG (Veytsman and Akhmadeeva, TUGboat issues tb38-2 and tb37-2). Hyphenated justified text read slightly faster but slightly worse on delayed tests. Unhyphenated justified text showed no comprehension difference and was read faster. Specifics UNVERIFIED.
- BUR (Burnhill and Harley, three experiments; journal and year UNVERIFIED). No significant differences in reading speed or comprehension.
- NJIT (eight-experiment sequence, https://digitalcommons.njit.edu/fac_pubs/16297; year UNVERIFIED). Four justification methods. Concludes there is no proven reading-time or retention advantage for ragged-right.
- Secondhand claim: about 5% comprehension gain for justified text (Hartley and Burnhill 1971). UNVERIFIED. Do not use.
- Verdict: MODERATE that ragged-right does not clearly beat justified text for comprehension. Justification method (wide word spaces, rivers) matters.

Hyphenation:
- HAI18 (Haikio, Heikkila, Kaakinen 2018, Journal of Educational Psychology). 36 second graders. Syllable hyphenation slowed reading more for good comprehenders. Comprehension results mixed by measure.
- HAI15 and HAI16 (Haikio et al., Finnish first and second graders). Hyphenation slowed word and sentence reading. Details UNVERIFIED.
- A 2020 Quarterly Journal of Experimental Psychology study on Hebrew compounds (secondary) found a hyphen slows reading, less so when a suffix already marks the compound.
- Adult English: no study found.
- Verdict: MODERATE that hyphens slow young readers. UNVERIFIED for adults. Default to no hyphenation with a user toggle.

Italic:
- A 48-dyslexic-reader eye-tracking study (authors UNVERIFIED, secondary only) found italic fonts reduced reading performance relative to roman, sans-serif and monospaced fonts.
- A usability newsletter found no reliable speed difference between Verdana and Verdana Italic (UNVERIFIED).
- Verdict: WEAK. Keep italic for short emphasis, not running text.

Underline:
- No research found. Design judgment only: underline reads as a link. Not evidence.

All caps:
- TIN28 (Tinker and Paterson 1928). Secondary: lowercase text read about 13% faster than uppercase. The uppercase text also took about 35% more space, which is a confound. Primary UNVERIFIED.
- PER17 (Perea and colleagues, eye-tracking, about 2017). Lowercase sentences read faster than uppercase. Authors partly UNVERIFIED.
- Word-shape account: lowercase ascenders and descenders give distinctive shapes. Size confound noted in secondary sources.
- Verdict: MODERATE that all caps slow running text. Use caps for short labels and headings only.

## 10. Eye movements a reading tool should respect

- RAY98 (Rayner 1998, Psychological Bulletin 124(3):372-422, https://doi.org/10.1037/0033-2909.124.3.372). Review of 20 years of eye-movement research: fixations, saccades, perceptual span, regressions, individual differences including dyslexia.
- RAY09 (Rayner 2009, Quarterly Journal of Experimental Psychology 62(8):1457-1506; Bartlett lecture). Perceptual span, preview benefit, eye-movement control. Typical perceptual-span numbers for English (roughly 3 to 4 letters left of fixation, 14 to 15 letters right) are from standard reviews and UNVERIFIED here.
- SCH14 (Schotter, Tran, Rayner 2014, Psychological Science, https://doi.org/10.1177/0956797614531148). Trailing-mask design made each word readable only once. Comprehension fell. Regressions support comprehension. Direct challenge to RSVP speed-reading apps. Sample UNVERIFIED. Independent replication not found in this pass.
- MOU25 (Moussaoui, Siddiqi, Cheung, Niemeier 2025, Journal of the International Neuropsychological Society, https://doi.org/10.1017/S1355617725101628; online November 2025). Undergraduates with and without ADHD. Full text vs PACED (one word at a time in its original position) vs RSVP (center). The ADHD group did better with minimized eye movement. A secondary summary reports about 13% relative gain (UNVERIFIED). Sample size UNVERIFIED.
- Verdict: AGAINST RSVP for ordinary readers' comprehension. WEAK for an ADHD benefit, from one study.
- Design: keep regressions possible. Do not default to RSVP.

## 11. Reading rulers, line guides, focus masks

- NIK23 (Niklaus, Cai, Bylinskii, Wallace 2023, CHI '23, https://doi.org/10.1145/3544548.3581367; arXiv 2303.04221). Four digital ruler designs: Grey Bar, Lightbox, Shade, Underline. Crowdsourced: 91 readers with dyslexia, 86 without. Per the Adobe summary (not the paper's table), Grey Bar, Shade and Underline gave about 10 to 20 words-per-minute average speed gains over no ruler. Largest gains for readers with dyslexia. Readers without dyslexia did not read faster, though many liked rulers. Preference did not match speed.
- PLOS13 (PLoS ONE 2013, doi 10.1371/journal.pone.0071161 from the figure record; authors UNVERIFIED). 103 high school students with dyslexia. A short-line device showing few words per line improved speed and comprehension for subsets. This is not a ruler.
- Focus masks: no controlled study found (UNVERIFIED).
- Verdict: MODERATE that rulers help readers with dyslexia read faster. WEAK for other readers. No evidence for focus masks.

## 12. Personalization

- WAL22 (above): the 35% fastest-to-slowest spread, and "one font does not fit all."
- KAD21 (Kadner, Keller, Rothkopf 2021, CHI '21, https://doi.org/10.1145/3411764.3445140). AdaptiFont: generative font space with Bayesian optimization. Significantly raised individual reading speed. Found significantly different optimal fonts across individuals. Lab study, N UNVERIFIED.
- WAL22b and DAY24 (above): individual spacing and font gains for children.
- NIK23 (above): preference diverged from measured speed.
- "Readability Consortium" work: no primary found. Treat as UNVERIFIED.
- Verdict: STRONG that optimal settings vary per person (WAL22 and KAD21 from different groups, with DAY24 partly overlapping). MODERATE that letting readers tune helps: the evidence shows variation, not that a settings panel improves outcomes for most people. Speed and preference come apart (NIK23).

---

## References (short keys)

- WAL22: Wallace S, Bylinskii Z, Dobres J, Kerr B, Berlow S, Treitman R, Kumawat N, Arpin K, Miller DB, Huang J. Towards Individuated Reading Experiences. ACM TOCHI, 2022. https://doi.org/10.1145/3502222
- WAL22b: Wallace S, Dobres J, Bylinskii Z, Sawyer B. Space for Readability. Journal of Vision 22(14):3349, 2022. https://doi.org/10.1167/jov.22.14.3349
- KAD21: Kadner F, Keller Y, Rothkopf CA. AdaptiFont. CHI 2021. https://doi.org/10.1145/3411764.3445140
- DAY24: Day S, Atilgan N, Giroux A, Sawyer BD. Education Sciences 14(8):854, 2024. https://doi.org/10.3390/educsci14080854
- BER01: Bernard ML, Liao CH, Mills MM. CHI '01 Extended Abstracts, 2001. https://doi.org/10.1145/634067.634173
- MIL01: Mills, Peterson, Storrer. Usability News, 2001. UNVERIFIED primary.
- ARD05: Arditi A, Cho J. Serifs and font legibility. Vision Research, 2005. https://doi.org/10.1016/j.visres.2005.06.013
- RIC22: Richardson JTE. The Legibility of Letters and Words. SpringerBriefs, 2022. https://doi.org/10.1007/978-3-030-90984-0
- LEG11: Legge GE, Bigelow CA. Does print size matter for reading? Journal of Vision 11(5):8, 2011. https://doi.org/10.1167/11.5.8
- CHU98: Chung STL, Mansfield JS, Legge GE. Vision Research, 1998. https://doi.org/10.1016/s0042-6989(98)00072-8
- PEL04: Pelli DG, Palomares M, Majaj NJ. Journal of Vision 4(12):1136-1169, 2004. https://doi.org/10.1167/4.12.12
- PEL08: Pelli DG, Tillman KA. The uncrowded window of object recognition. Nature Neuroscience 11(10):1129-1135, 2008. https://doi.org/10.1038/nn.2187
- ZOR12: Zorzi M, Barbiero C, Facoetti A, et al. Extra-large letter spacing improves reading in dyslexia. PNAS, 2012. https://doi.org/10.1073/pnas.1205566109
- SJO16: Sjoblom AM, Eaton E, Stagg SD. British Journal of Educational Psychology, 2016. https://doi.org/10.1111/bjep.12127
- STA21: Stagg SD, Kiss N. Research in Developmental Disabilities, 2021. https://doi.org/10.1016/j.ridd.2021.104065
- PER12: Perea M, Panadero V, Moret-Tatay C, Gomez P. Learning and Instruction, 2012. UNVERIFIED details.
- PG12: Perea M, Gomez P. Subtle increases in interletter spacing facilitate the encoding of words during normal reading. PLoS ONE, 2012. UNVERIFIED details.
- WCAG-1.4.12: W3C Understanding SC 1.4.12, https://www.w3.org/WAI/WCAG22/Understanding/text-spacing
- WCAG-1.4.3: W3C Understanding SC 1.4.3, https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum
- DYS01: Dyson MC, Haselgrove M. International Journal of Human-Computer Studies 54(4):585-612, 2001. UNVERIFIED primary.
- DYS98: Dyson MC, Kipping GJ. LNCS, 1998. https://doi.org/10.1007/bfb0053278
- BUC09: Buchner A, Mayr S, Brandt M. Ergonomics, 2009. https://doi.org/10.1080/00140130802641635
- PIE13: Piepenbrock C, Mayr S, Mund I, Buchner A. Ergonomics, 2013. https://doi.org/10.1080/00140139.2013.790485
- PIE14a: Piepenbrock C, Mayr S, Buchner A. Human Factors, 2014. https://pubmed.ncbi.nlm.nih.gov/25141597/
- PIE14b: Piepenbrock C, Mayr S, Buchner A. Ergonomics, 2014. https://doi.org/10.1080/00140139.2014.948496
- REL17: Rello L, Bigham JP. Good Background Colors for Readers. ASSETS '17, 2017. https://doi.org/10.1145/3132525.3132546
- CHA15: Chang AM, Aeschbach D, Duffy JF, Czeisler CA. PNAS 112(4):1232-1237, 2015. https://pubmed.ncbi.nlm.nih.gov/25535358/
- COC23: Cochrane review CD013244, 2023. https://www.cochrane.org/CD013244
- GRI16: Griffiths PG, Taylor RH, Henderson LM, Barrett BT. Ophthalmic and Physiological Optics 36(5):519-544, 2016. https://doi.org/10.1111/opo.12316
- EVA16: Evans BJW, Allen PM. Journal of Optometry 9(4):205-218, 2016. https://doaj.org/article/0c1d9e49b74740cda05af8e9144e28d2
- EVA16L: Evans BJW. Ophthalmic and Physiological Optics, 2016. https://doi.org/10.1111/opo.12330
- RIT11: Ritchie SJ, Della Sala S, McIntosh RD. Pediatrics 128:e932-e938, 2011. Confirmed from a reference list only.
- DIE11: Diemand-Yauman C, Oppenheimer DM, Vaughan EB. Cognition, 2011. https://doi.org/10.1016/j.cognition.2010.09.012
- TAY20: Taylor A, Sanson M, Burnell R, Wade KA, Garry M. Memory, 2020. https://doi.org/10.1080/09658211.2020.1758726
- GEL20: Geller J, Davis SD, Peterson D. OSF preprint, 2020. https://doi.org/10.31234/osf.io/ku5bz
- XIE18: Xie et al. disfluency meta-analysis, 2018. UNVERIFIED journal and authors.
- EPR20: Reproducibility commentary, Educational Psychology Review, 2020. https://doi.org/10.1007/s10648-020-09579-1
- SNE24: Snell J. No, Bionic Reading does not work. Acta Psychologica, 2024. https://doi.org/10.1016/j.actpsy.2024.104304
- BIO25a: Registered report, Royal Society Open Science, 2025. UNVERIFIED authors and date.
- BIO25b: Beelders, Journal of Eye Movement Research, 2025. UNVERIFIED.
- ORE90: O'Regan JK. Eye movements and reading. Reviews of Oculomotor Research 4, 1990. UNVERIFIED primary.
- ORE92: O'Regan JK, Jacobs AM. Journal of Experimental Psychology: HPP 18(1):185-197, 1992. UNVERIFIED primary.
- BRY05: Brysbaert M, Nazir TA. Journal of Research in Reading, 2005. UNVERIFIED primary.
- WER17: Wery JJ, Diliberto JA. Annals of Dyslexia, 2016 online. https://doi.org/10.1007/s11881-016-0127-1
- KUS17: Kuster SM, van Weerdenburg M, Gompel M, Bosman AMT. Annals of Dyslexia, 2017 online. https://doi.org/10.1007/s11881-017-0154-6
- FRA19: Franzen L, Stark Z, Johnson A. Annals of Eye Science, 2019, AB004. https://doi.org/10.21037/aes.2019.ab004
- HAI18: Haikio T, Heikkila R, Kaakinen J. Journal of Educational Psychology, 2018. UNVERIFIED details.
- TIN28: Tinker MA, Paterson DG, 1928. Secondary only.
- PER17: Perea M and colleagues, eye-tracking case study, about 2017. UNVERIFIED authors.
- RAY98: Rayner K. Psychological Bulletin 124(3):372-422, 1998. https://doi.org/10.1037/0033-2909.124.3.372
- RAY09: Rayner K. Quarterly Journal of Experimental Psychology 62(8):1457-1506, 2009. UNVERIFIED DOI.
- SCH14: Schotter ER, Tran R, Rayner K. Psychological Science, 2014. https://doi.org/10.1177/0956797614531148
- MOU25: Moussaoui S, Siddiqi AA, Cheung TCK, Niemeier M. JINS, 2025. https://doi.org/10.1017/S1355617725101628
- NIK23: Niklaus A, Cai T, Bylinskii Z, Wallace S. Digital Reading Rulers. CHI '23, 2023. https://doi.org/10.1145/3544548.3581367
- PLOS13: PLoS ONE 2013, doi 10.1371/journal.pone.0071161. Authors UNVERIFIED.

---

## Design rules for Polycarp (typography and color)

1. Let readers choose font, size, letter spacing, word spacing and line height, and make every choice reversible. [STRONG: WAL22, KAD21, DAY24]
2. Do not claim any font family is fastest for everyone; serif vs sans main effects are small or absent at matched size. [MODERATE: WAL22, DAY24, BER01]
3. Default body text to 16 px or larger on screen and let readers go higher; older readers rated and read larger text better. [MODERATE: BER01, LEG11]
4. Offer a size range wide enough for a fluent range, about a tenfold x-height span, not a narrow 12 to 14 px cap. [MODERATE: LEG11]
5. Expose letter and word spacing controls, with the WCAG 1.4.12 values as the override ceiling, not a proven optimum. [MODERATE for the control: ZOR12, WAL22b; WEAK for exact values: WCAG-1.4.12]
6. Default to about 60 to 75 characters per line and allow up to about 100 without penalty. [WEAK: DYS01]
7. Default to dark text on a light background; offer inverted display as an option. [MODERATE: BUC09, PIE13, PIE14b]
8. Do not claim dark mode protects eyes, helps astigmatism or speeds reading. [AGAINST for the speed claim: PIE13 and BUC09 favor positive polarity; WEAK for dim-room comfort]
9. Use WCAG 1.4.3 contrast (4.5:1 for body text) as the floor, and let readers raise it; its basis is low-vision sensitivity, not a reading-speed study. [MODERATE: WCAG-1.4.3]
10. Offer warm background choices (peach, cream, light yellow) as preferences; do not say they cure dyslexia. [WEAK: REL17]
11. Do not sell blue-light filters, warm tints or "eye strain" relief claims. [AGAINST: COC23; MODERATE that evening screen light shifts sleep in a small lab study: CHA15]
12. Offer colored overlays only as a user-chosen tint with no clinical claim and no Irlen-style screening. [AGAINST: GRI16, RIT11; WEAK for the visual-stress subgroup: EVA16]
13. No disfluent "hard to read" fonts in any study or learning feature. [AGAINST: TAY20, GEL20, XIE18]
14. Do not ship bionic (bolded word starts) as a speed feature; if offered, label it a visual preference. [AGAINST: SNE24; BIO25a and BIO25b unverified but also null]
15. Keep regressions possible: no forced one-word-at-a-time display by default, and any RSVP mode is opt-in with no general comprehension claim. [AGAINST for general readers: SCH14; WEAK for ADHD: MOU25]
16. Default to ragged-right text and no automatic hyphenation; offer justified text and hyphens as options. [MODERATE: TUG, NJIT, HAI18 (young readers)]
17. Keep italic and all caps out of running body text; use them for short emphasis, labels and headings. [MODERATE for all caps: TIN28 (UNVERIFIED primary); WEAK for italics]
18. Offer a reading ruler or line guide as an opt-in tool, with the strongest case for readers with dyslexia. [MODERATE: NIK23]
19. Do not promise speed gains from Lexend, Atkinson Hyperlegible or OpenDyslexic; list them as options. Dyslexie specifically is contradicted. [WEAK: Lexend, Atkinson, OpenDyslexic; AGAINST for Dyslexie: KUS17]
20. Measure per reader before any claim: an in-product check of speed and comprehension, reported at the individual level only. [WEAK: design inference from WAL22 and NIK23]
