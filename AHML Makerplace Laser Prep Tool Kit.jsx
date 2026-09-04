// AHML Makerplace Laser Prep Tool Kit.jsx
// Adobe Illustrator ExtendScript
//
// A small toolkit of fixes for common laser-cutting file problems, picked
// from a main menu. Each tool explains what it does and asks before
// changing anything irreversible-feeling (though every change here is a
// normal Illustrator edit - Cmd+Z undoes it like anything else).
//
// TOOL 1: FIX OVERLAPPING LINES
// Cleans up wasted laser time from duplicate/overlapping cut lines, and
// flags (but never auto-removes) engrave lines that sit on top of a cut.
// See the comment above openOverlapTool() below for the full rules.
//
// TOOL 2: FIX RASTER CONFUSION
// Sometimes - not always, cause unknown - a raster image in the file
// confuses the Epilog driver into reading the ENTIRE job as one big
// engrave and ignoring the vector cuts entirely. The empirical fix
// (found by trial and error, not a documented cause) is to re-export
// every raster image to a fresh file and re-place it in the exact same
// spot. This tool automates exactly that - it doesn't try to explain
// why it works, only reproduce the fix reliably every time.
//
// INSTALL: File > Scripts > Other Script... and pick this file (no install
// needed), or copy it into Illustrator's Scripts folder (Mac: e.g.
// /Applications/Adobe Illustrator [version]/Presets/en_US/Scripts/ - Windows:
// e.g. C:\Program Files\Adobe\Adobe Illustrator [version]\Presets\en_US\Scripts\)
// and restart Illustrator to get it listed under File > Scripts. On a
// station with the desktop icon installed, just double-click that instead.
//
// NOTE: Tool 1 has been run and re-verified against real Illustrator files
// on macOS. Tool 2 (raster fix) has been verified against Illustrator's
// scripting DOM directly (imageCapture, hide/restore isolation, embed()
// severing the file link) but NOT against a real Epilog driver, since that
// part of the bug is outside anything a script can test - only that it
// faithfully reproduces the re-export-and-replace steps. Try both on a
// duplicate of a real file first, not the only copy.

#target illustrator

(function () {

    // =================================================================
    // TOOL 1: FIX OVERLAPPING LINES
    // =================================================================
    //
    // Two problems this solves, both about wasted laser time:
    //
    // 1) DUPLICATE / OVERLAPPING CUT LINES - the same cut line traced twice
    //    (or two lines that partly overlap) means the laser cuts that stretch
    //    of material more than once.
    // 2) A VECTOR LINE GETTING ENGRAVED WHERE A CUT WILL ALSO HAPPEN - a
    //    heavier-weight stroke sitting on top of (or partly along) a cut line
    //    means the laser wastes an engrave pass on material that's about to be
    //    cut away.
    //
    // This only ever looks at STROKED LINES. Fills, raster images, and placed
    // art are never touched, no matter how much they overlap anything -
    // overlapping artwork is normal and fine.
    //
    // CUT vs. ENGRAVE CLASSIFICATION
    // Epilog's driver identifies vector cut/score lines by stroke WEIGHT, not
    // color: a hairline stroke (~0.001 in / 0.072 pt) means "cut this line."
    // A heavier stroke gets engraved instead. This script uses that same rule
    // and never looks at stroke color.
    //
    // HOW IT WORKS
    // - "Check My File" only SELECTS what it finds - nothing changes yet.
    //     - Exact duplicate cut lines, and cut lines whose entire length is
    //       already covered by another cut line, are flagged as safe to remove.
    //       Removing these never changes the physical cut - the laser still
    //       traces the same path once instead of twice.
    //     - Engrave-weight lines that overlap a cut line - fully or partly -
    //       are NEVER auto-removed, only flagged for manual review. Unlike a
    //       redundant cut line, deleting an engrave line changes what actually
    //       gets marked on the material, and the overlap check has real edge
    //       cases (tolerance, curves not fully analyzed) - a wrong auto-delete
    //       here silently destroys artwork, so a human makes the final call.
    //     - Two cut lines that only PARTLY overlap (each has some shared
    //       length, but also length of its own) are auto-fixed when it's safe
    //       to: if both are simple straight 2-point lines, the shorter one is
    //       shortened down to just its non-overlapping stretch, eliminating
    //       the double-cut entirely - the laser only traces the overlap once
    //       (on the longer line). Anything more complex (a multi-point
    //       polyline, a curve, a closed path) is left flagged for manual
    //       review instead, since safely picking which interior points to
    //       keep isn't something to automate.
    // - "Fix It" removes redundant cut lines and shortens partially-
    //   overlapping ones.

    // ---------------------------------------------------------------
    // Tunables
    // ---------------------------------------------------------------

    // Epilog looks for a 0.001in stroke to mean "cut this." 0.001in = 0.072pt
    // (Illustrator's DOM always reports strokeWidth in points, regardless of
    // the ruler units shown on screen). Anything at or below this counts as
    // a cut/score line; anything heavier is an engrave-weight line. Widen
    // this if your actual hairline setting differs.
    var HAIRLINE_MAX_PT = 0.15;

    var HANDLE_TOL = 0.05;      // pt - how close a bezier handle must be to
                                 // its anchor to count as "no handle" (straight)
    var POINT_TOL = 0.75;       // pt - how close two points must be to count
                                 // as the same point (~1/4mm)

    // ---------------------------------------------------------------
    // Small geometry helpers
    // ---------------------------------------------------------------

    function dist(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    function pointsClose(a, b, tol) {
        return dist(a, b) <= tol;
    }

    function handleIsFlat(anchor, handle) {
        return dist(anchor, handle) <= HANDLE_TOL;
    }

    function round(n, places) {
        var f = Math.pow(10, places);
        return Math.round(n * f) / f;
    }

    // ---------------------------------------------------------------
    // Collecting items
    // ---------------------------------------------------------------

    function collectPathItems(doc) {
        var items = [];
        var i;
        for (i = 0; i < doc.pathItems.length; i++) {
            items.push(doc.pathItems[i]);
        }
        // Compound path sub-paths aren't always reachable via doc.pathItems -
        // walk compound paths explicitly and skip anything we've already got.
        for (i = 0; i < doc.compoundPathItems.length; i++) {
            var cp = doc.compoundPathItems[i];
            for (var j = 0; j < cp.pathItems.length; j++) {
                var sub = cp.pathItems[j];
                if (!containsRef(items, sub)) items.push(sub);
            }
        }
        return items;
    }

    function containsRef(arr, obj) {
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === obj) return true;
        }
        return false;
    }

    function isEditable(pathItem) {
        try {
            if (pathItem.locked || pathItem.hidden) return false;
            var layer = pathItem.layer;
            while (layer) {
                if (layer.locked || !layer.visible) return false;
                layer = layer.parent && layer.parent.typename === "Layer" ? layer.parent : null;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function isCutLine(pathItem) {
        try {
            if (pathItem.guides) return false;
            if (!pathItem.stroked) return false;
            if (pathItem.strokeWidth > HAIRLINE_MAX_PT) return false;
            if (pathItem.pathPoints.length < 2) return false;
            return isEditable(pathItem);
        } catch (e) {
            return false;
        }
    }

    function isEngraveLine(pathItem) {
        try {
            if (pathItem.guides) return false;
            if (!pathItem.stroked) return false;
            if (pathItem.strokeWidth <= HAIRLINE_MAX_PT) return false;
            if (pathItem.pathPoints.length < 2) return false;
            return isEditable(pathItem);
        } catch (e) {
            return false;
        }
    }

    // record: { path, points: [[x,y],...], segments: [{a,b}], hasCurve }
    function analyzePathGeometry(pathItem) {
        var pts = pathItem.pathPoints;
        var n = pts.length;
        var points = [];
        var i;
        for (i = 0; i < n; i++) points.push(pts[i].anchor);

        var segments = [];
        var hasCurve = false;
        var count = pathItem.closed ? n : n - 1;
        for (i = 0; i < count; i++) {
            var p1 = pts[i];
            var p2 = pts[(i + 1) % n];
            var straight = handleIsFlat(p1.anchor, p1.rightDirection) &&
                handleIsFlat(p2.anchor, p2.leftDirection);
            if (straight) {
                segments.push({ a: p1.anchor, b: p2.anchor });
            } else {
                hasCurve = true;
            }
        }

        return { path: pathItem, points: points, segments: segments, hasCurve: hasCurve };
    }

    // ---------------------------------------------------------------
    // Exact whole-path duplicate detection
    // ---------------------------------------------------------------

    function samePointSet(ptsA, ptsB) {
        if (ptsA.length !== ptsB.length) return false;
        var n = ptsA.length;
        var i, fwd = true, bwd = true;
        for (i = 0; i < n; i++) {
            if (!pointsClose(ptsA[i], ptsB[i], POINT_TOL)) { fwd = false; break; }
        }
        if (fwd) return true;
        for (i = 0; i < n; i++) {
            if (!pointsClose(ptsA[i], ptsB[n - 1 - i], POINT_TOL)) { bwd = false; break; }
        }
        return bwd;
    }

    // ---------------------------------------------------------------
    // Collinear bucket key for a straight segment, plus 1D projection.
    // ---------------------------------------------------------------

    function segmentLine(seg) {
        var dx = seg.b[0] - seg.a[0];
        var dy = seg.b[1] - seg.a[1];
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return null;
        var ux = dx / len, uy = dy / len;
        if (ux < 0 || (Math.abs(ux) < 1e-9 && uy < 0)) { ux = -ux; uy = -uy; }
        var angle = Math.atan2(uy, ux); // in [0, PI)
        var nx = -uy, ny = ux;
        var offset = seg.a[0] * nx + seg.a[1] * ny;
        return { ux: ux, uy: uy, angle: angle, offset: offset };
    }

    function bucketKey(line) {
        return round(line.angle, 3) + "|" + round(line.offset / POINT_TOL, 0);
    }

    function project(line, pt) {
        return pt[0] * line.ux + pt[1] * line.uy;
    }

    function segmentInterval(seg) {
        var line = segmentLine(seg);
        if (!line) return null;
        var t0 = project(line, seg.a);
        var t1 = project(line, seg.b);
        if (t0 > t1) { var tmp = t0; t0 = t1; t1 = tmp; }
        return { bucket: bucketKey(line), t0: t0, t1: t1 };
    }

    function mergeIntervals(intervals) {
        var merged = [];
        for (var i = 0; i < intervals.length; i++) {
            var cur = intervals[i];
            if (merged.length === 0) {
                merged.push([cur[0], cur[1]]);
                continue;
            }
            var last = merged[merged.length - 1];
            if (cur[0] <= last[1] + POINT_TOL) {
                if (cur[1] > last[1]) last[1] = cur[1];
            } else {
                merged.push([cur[0], cur[1]]);
            }
        }
        return merged;
    }

    function intervalCoveredBy(t0, t1, coverage) {
        for (var i = 0; i < coverage.length; i++) {
            if (coverage[i][0] - POINT_TOL <= t0 && coverage[i][1] + POINT_TOL >= t1) return true;
        }
        return false;
    }

    function intervalTouches(t0, t1, coverage) {
        for (var i = 0; i < coverage.length; i++) {
            if (coverage[i][0] < t1 - 1e-6 && coverage[i][1] > t0 + 1e-6) return true;
        }
        return false;
    }

    function pathLength(rec) {
        var total = 0;
        for (var i = 0; i < rec.segments.length; i++) {
            total += dist(rec.segments[i].a, rec.segments[i].b);
        }
        return total;
    }

    // Build merged per-bucket coverage from a set of straight-line records.
    function buildCoverage(records) {
        var coverage = {};
        for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            for (var s = 0; s < rec.segments.length; s++) {
                var iv = segmentInterval(rec.segments[s]);
                if (!iv) continue;
                if (!coverage[iv.bucket]) coverage[iv.bucket] = [];
                coverage[iv.bucket].push([iv.t0, iv.t1]);
            }
        }
        for (var bk in coverage) {
            if (!coverage.hasOwnProperty(bk)) continue;
            coverage[bk].sort(function (a, b) { return a[0] - b[0]; });
            coverage[bk] = mergeIntervals(coverage[bk]);
        }
        return coverage;
    }

    function addToCoverage(coverage, rec) {
        var toAdd = {};
        for (var s = 0; s < rec.segments.length; s++) {
            var iv = segmentInterval(rec.segments[s]);
            if (!iv) continue;
            if (!toAdd[iv.bucket]) toAdd[iv.bucket] = [];
            toAdd[iv.bucket].push([iv.t0, iv.t1]);
        }
        for (var bk in toAdd) {
            if (!toAdd.hasOwnProperty(bk)) continue;
            var combined = (coverage[bk] || []).concat(toAdd[bk]);
            combined.sort(function (a, b) { return a[0] - b[0]; });
            coverage[bk] = mergeIntervals(combined);
        }
    }

    // Classify a straight-line record against an existing coverage map:
    // 'full' = every segment already covered, 'partial' = some overlap but
    // not all, 'none' = no meaningful overlap.
    function classifyAgainstCoverage(rec, coverage) {
        if (rec.segments.length === 0) return "none";
        var fullyCovered = true;
        var touches = false;
        for (var s = 0; s < rec.segments.length; s++) {
            var iv = segmentInterval(rec.segments[s]);
            if (!iv) continue;
            var existing = coverage[iv.bucket] || [];
            if (intervalTouches(iv.t0, iv.t1, existing)) touches = true;
            if (!intervalCoveredBy(iv.t0, iv.t1, existing)) fullyCovered = false;
        }
        if (!touches) return "none";
        return fullyCovered ? "full" : "partial";
    }

    // Reconstruct a 2D point from a 1D parameter along a bucketed line.
    // Inverse of project()/offset: since (ux,uy) and (nx,ny) are an
    // orthonormal pair, p = t*(ux,uy) + offset*(nx,ny) exactly recovers it.
    function pointAtParam(line, t) {
        var nx = -line.uy, ny = line.ux;
        return [t * line.ux + line.offset * nx, t * line.uy + line.offset * ny];
    }

    // For a straight segment classified "partial" against existing coverage,
    // work out the single leftover uncovered sub-interval. Given records are
    // processed longest-first, any coverage-contributing segment touching
    // this one only from one side must itself extend past that side's edge
    // (an interior-only overlap would require a shorter segment to have been
    // processed first, which the sort order rules out) - so at most one
    // interval eats into t0 and at most one eats into t1, and what's left in
    // between is always a single contiguous stretch. Never two disjoint
    // leftover pieces to worry about.
    function computeTrim(seg, coverage) {
        var iv = segmentInterval(seg);
        if (!iv) return null;
        var line = segmentLine(seg);
        var existing = coverage[iv.bucket] || [];
        var t0 = iv.t0, t1 = iv.t1;
        var newT0 = t0, newT1 = t1;
        for (var i = 0; i < existing.length; i++) {
            var c0 = existing[i][0], c1 = existing[i][1];
            if (c0 <= t0 + POINT_TOL && c1 > t0 && c1 - POINT_TOL > newT0) newT0 = c1;
            if (c1 >= t1 - POINT_TOL && c0 < t1 && c0 + POINT_TOL < newT1) newT1 = c0;
        }
        if (newT0 >= newT1 - POINT_TOL) return { empty: true };
        return { line: line, t0: newT0, t1: newT1 };
    }

    // ---------------------------------------------------------------
    // Cut-line analysis (color-blind - every hairline stroke is compared
    // against every other one, since Epilog doesn't distinguish by color).
    // ---------------------------------------------------------------

    // Groups final-state simple cut lines that are collinear and touch
    // end-to-end (zero gap, within tolerance) into join groups. Joining
    // these produces the exact same physical cut - one continuous stroke
    // instead of two that happen to meet - so it's as safe as duplicate
    // removal, just cosmetic/efficiency cleanup for the toolpath itself.
    // `survivors` must already be gap-free of overlaps (guaranteed since
    // this only ever sees post-dedup/subsumption/trim final intervals).
    function analyzeJoins(survivors) {
        var byBucket = {};
        var i;
        for (i = 0; i < survivors.length; i++) {
            var s = survivors[i];
            if (!byBucket[s.bucket]) byBucket[s.bucket] = [];
            byBucket[s.bucket].push(s);
        }

        var groups = [];
        for (var bk in byBucket) {
            if (!byBucket.hasOwnProperty(bk)) continue;
            var list = byBucket[bk];
            list.sort(function (a, b) { return a.t0 - b.t0; });
            var idx = 0;
            while (idx < list.length) {
                var chain = [list[idx]];
                var j = idx;
                while (j + 1 < list.length && list[j + 1].t0 <= chain[chain.length - 1].t1 + POINT_TOL) {
                    chain.push(list[j + 1]);
                    j++;
                }
                if (chain.length > 1) {
                    var primary = chain[0];
                    for (var k = 1; k < chain.length; k++) {
                        if ((chain[k].t1 - chain[k].t0) > (primary.t1 - primary.t0)) primary = chain[k];
                    }
                    var others = [];
                    for (k = 0; k < chain.length; k++) if (chain[k] !== primary) others.push(chain[k]);
                    groups.push({
                        primary: primary,
                        others: others,
                        line: primary.line,
                        t0: chain[0].t0,
                        t1: chain[chain.length - 1].t1
                    });
                }
                idx = j + 1;
            }
        }
        return groups;
    }

    function analyzeCutLines(cutRecords) {
        var duplicates = [];
        var subsumed = [];
        var trimmed = [];   // partial overlap, auto-shortened to its unique length
        var partial = [];   // partial overlap, too complex to auto-fix - manual review
        var survivors = []; // final-state simple cut lines, candidates for joining

        // 1) exact whole-path duplicates
        var alive = [];
        var i, j;
        for (i = 0; i < cutRecords.length; i++) {
            var rec = cutRecords[i];
            var isDup = false;
            for (j = 0; j < alive.length; j++) {
                if (samePointSet(rec.points, alive[j].points)) { isDup = true; break; }
            }
            if (isDup) duplicates.push(rec);
            else alive.push(rec);
        }

        // 2) straight-segment subsumption / partial overlap, longest first
        //    so long "primary" lines are preferred as the one that's kept.
        var straightAlive = [];
        for (i = 0; i < alive.length; i++) {
            if (!alive[i].hasCurve && alive[i].segments.length > 0) straightAlive.push(alive[i]);
        }
        straightAlive.sort(function (a, b) { return pathLength(b) - pathLength(a); });

        var coverage = {};
        for (i = 0; i < straightAlive.length; i++) {
            rec = straightAlive[i];
            var eligible = !rec.path.closed && rec.points.length === 2 && rec.segments.length === 1;
            var status = classifyAgainstCoverage(rec, coverage);
            if (status === "full") {
                subsumed.push(rec);
            } else {
                if (status === "partial") {
                    // Auto-trimming only for the simple, unambiguous case: an
                    // open, straight, single-segment (2-point) cut line. Any
                    // multi-point polyline or curve is left for manual review -
                    // reconstructing which interior points to keep isn't safe
                    // to automate.
                    var trim = eligible ? computeTrim(rec.segments[0], coverage) : null;
                    if (trim && trim.empty) {
                        subsumed.push(rec); // leftover length is negligible - just remove it
                    } else if (trim) {
                        trimmed.push({ rec: rec, line: trim.line, t0: trim.t0, t1: trim.t1 });
                        survivors.push({ rec: rec, path: rec.path, bucket: bucketKey(trim.line), t0: trim.t0, t1: trim.t1, line: trim.line });
                    } else {
                        partial.push(rec);
                    }
                } else if (eligible) {
                    // status "none" - untouched, and simple enough to be a join candidate
                    var iv = segmentInterval(rec.segments[0]);
                    survivors.push({ rec: rec, path: rec.path, bucket: iv.bucket, t0: iv.t0, t1: iv.t1, line: segmentLine(rec.segments[0]) });
                }
                addToCoverage(coverage, rec);
            }
        }

        var joined = analyzeJoins(survivors);

        return { duplicates: duplicates, subsumed: subsumed, trimmed: trimmed, partial: partial, joined: joined };
    }

    // ---------------------------------------------------------------
    // Engrave-line-vs-cut-line analysis. Only checks engrave lines against
    // the cut coverage - engrave lines are never compared to each other,
    // and fills/raster/placed art are never considered at all.
    // ---------------------------------------------------------------

    function analyzeEngraveLines(engraveRecords, cutCoverage) {
        var redundant = [];  // engrave line entirely on top of cut line(s) - safe to remove
        var partial = [];    // engrave line partly on top of cut line(s) - review manually

        for (var i = 0; i < engraveRecords.length; i++) {
            var rec = engraveRecords[i];
            if (rec.hasCurve || rec.segments.length === 0) continue; // curves: not checked in v1
            var status = classifyAgainstCoverage(rec, cutCoverage);
            if (status === "full") redundant.push(rec);
            else if (status === "partial") partial.push(rec);
        }

        return { redundant: redundant, partial: partial };
    }

    // ---------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------

    function selectItems(doc, items) {
        doc.selection = items;
    }

    function removeRecords(records) {
        var n = 0;
        for (var i = 0; i < records.length; i++) {
            try { records[i].path.remove(); n++; } catch (e) { /* skip */ }
        }
        return n;
    }

    function setPathPoint(pp, xy) {
        pp.anchor = xy;
        pp.leftDirection = xy;
        pp.rightDirection = xy;
    }

    // Shortens each entry's 2-point path down to just its unique [t0,t1]
    // stretch, dropping whichever original endpoint fell inside another
    // cut line's coverage. Whichever original endpoint had the smaller
    // projected position moves to t0, the other to t1 - independent of
    // which pathPoint index happened to be which originally.
    function trimRecords(entries) {
        var n = 0;
        for (var i = 0; i < entries.length; i++) {
            try {
                var e = entries[i];
                var pts = e.rec.path.pathPoints;
                var p0 = pts[0], p1 = pts[1];
                var t0pt = project(e.line, p0.anchor);
                var t1pt = project(e.line, p1.anchor);
                var newLow = pointAtParam(e.line, e.t0);
                var newHigh = pointAtParam(e.line, e.t1);
                if (t0pt <= t1pt) {
                    setPathPoint(p0, newLow);
                    setPathPoint(p1, newHigh);
                } else {
                    setPathPoint(p0, newHigh);
                    setPathPoint(p1, newLow);
                }
                n++;
            } catch (err) { /* skip */ }
        }
        return n;
    }

    // Extends each join group's primary path to span the whole touching
    // chain, then deletes the other members it absorbed. Same endpoint-
    // mapping approach as trimRecords: whichever of the primary's two
    // original points projects smaller moves to the chain's t0 end.
    function applyJoins(groups) {
        var n = 0;
        for (var i = 0; i < groups.length; i++) {
            try {
                var g = groups[i];
                var pts = g.primary.path.pathPoints;
                var p0 = pts[0], p1 = pts[1];
                var t0pt = project(g.line, p0.anchor);
                var t1pt = project(g.line, p1.anchor);
                var newLow = pointAtParam(g.line, g.t0);
                var newHigh = pointAtParam(g.line, g.t1);
                if (t0pt <= t1pt) {
                    setPathPoint(p0, newLow);
                    setPathPoint(p1, newHigh);
                } else {
                    setPathPoint(p0, newHigh);
                    setPathPoint(p1, newLow);
                }
                for (var j = 0; j < g.others.length; j++) {
                    try { g.others[j].path.remove(); } catch (e) { /* skip */ }
                }
                n++;
            } catch (err) { /* skip */ }
        }
        return n;
    }

    // ---------------------------------------------------------------
    // Top-level scan
    // ---------------------------------------------------------------

    function scan(doc) {
        var allPaths = collectPathItems(doc);
        var cutRecords = [];
        var engraveRecords = [];
        var i;
        for (i = 0; i < allPaths.length; i++) {
            if (isCutLine(allPaths[i])) {
                cutRecords.push(analyzePathGeometry(allPaths[i]));
            } else if (isEngraveLine(allPaths[i])) {
                engraveRecords.push(analyzePathGeometry(allPaths[i]));
            }
        }

        var cutResult = analyzeCutLines(cutRecords);
        var cutCoverage = buildCoverage(cutRecords); // built from ALL cut lines, dupes included
        var engraveResult = analyzeEngraveLines(engraveRecords, cutCoverage);

        return {
            cutTotal: cutRecords.length,
            engraveTotal: engraveRecords.length,
            duplicates: cutResult.duplicates,
            subsumed: cutResult.subsumed,
            trimmed: cutResult.trimmed,
            joined: cutResult.joined,
            partial: cutResult.partial,
            engraveRedundant: engraveResult.redundant,
            enginePartial: engraveResult.partial
        };
    }

    // Builds one "  - N word(s) - detail" line, or "" if n is 0, so the
    // summary only ever mentions categories that actually apply.
    function bullet(n, word, detail) {
        if (n === 0) return "";
        return "  \u2022 " + n + " " + word + (n === 1 ? "" : "s") + " - " + detail + "\n";
    }

    function openOverlapTool(doc) {
        var lastResult = null;
        var folder = scriptFolder();

        var win = new Window("dialog", "Fix Overlapping Lines");
        paintDark(win);
        win.orientation = "column";
        win.alignChildren = "fill";
        win.margins = 16;
        win.spacing = 9;

        var headerRow = win.add("group");
        headerRow.orientation = "row";
        headerRow.alignChildren = "center";
        headerRow.spacing = 10;
        addBadge(headerRow, folder, "badge_overlap.png");
        var header = headerRow.add("statictext", undefined, "Check your file before cutting");
        header.graphics.font = ScriptUI.newFont(header.graphics.font.name, "BOLD", 17);
        colorText(header, THEME.text);

        var intro = win.add("statictext", undefined,
            "Looks for things that waste laser time, like a line accidentally drawn twice, and fixes the simple ones for you. It never touches colors, fills, images, or other artwork - only cut and engrave lines.",
            { multiline: true });
        intro.preferredSize.width = 420;
        colorText(intro, THEME.muted);

        var resultsPanel = win.add("panel", undefined, undefined);
        resultsPanel.graphics.backgroundColor = resultsPanel.graphics.newBrush(
            resultsPanel.graphics.BrushType.SOLID_COLOR, THEME.panelBg);
        resultsPanel.alignChildren = "fill";
        resultsPanel.margins = 14;

        var statusText = resultsPanel.add("statictext", undefined,
            "Click \"Check My File\" to get started.", { multiline: true });
        statusText.preferredSize.width = 400;
        statusText.preferredSize.height = 165;
        colorText(statusText, THEME.text);

        var btnRow = win.add("group");
        btnRow.orientation = "row";
        btnRow.alignChildren = "center";
        btnRow.spacing = 8;

        var findBtn, cleanBtn, backBtn;
        findBtn = addImageBtn(btnRow, folder, "btn_check_file.png", "Check My File", function () { findBtn_onClick(); });
        cleanBtn = addToggleImageBtn(btnRow, folder, "btn_fix_it.png", "btn_fix_it_disabled.png", "Fix It", function () { cleanBtn_onClick(); });
        backBtn = addImageBtn(btnRow, folder, "btn_back.png", "Back", function () { win.close(); });
        addEscapeToClose(win);

        function findBtn_onClick() {
            try {
                lastResult = scan(doc);

                var toSelect = [];
                var i;
                for (i = 0; i < lastResult.duplicates.length; i++) toSelect.push(lastResult.duplicates[i].path);
                for (i = 0; i < lastResult.subsumed.length; i++) toSelect.push(lastResult.subsumed[i].path);
                for (i = 0; i < lastResult.trimmed.length; i++) toSelect.push(lastResult.trimmed[i].rec.path);
                for (i = 0; i < lastResult.joined.length; i++) {
                    toSelect.push(lastResult.joined[i].primary.path);
                    for (var jo = 0; jo < lastResult.joined[i].others.length; jo++) toSelect.push(lastResult.joined[i].others[jo].path);
                }
                for (i = 0; i < lastResult.partial.length; i++) toSelect.push(lastResult.partial[i].path);
                for (i = 0; i < lastResult.engraveRedundant.length; i++) toSelect.push(lastResult.engraveRedundant[i].path);
                for (i = 0; i < lastResult.enginePartial.length; i++) toSelect.push(lastResult.enginePartial[i].path);
                selectItems(doc, toSelect);
                app.redraw();

                var removableCount = lastResult.duplicates.length + lastResult.subsumed.length;
                var trimCount = lastResult.trimmed.length;
                var joinCount = lastResult.joined.length;
                var actionableCount = removableCount + trimCount + joinCount;
                var reviewCount = lastResult.partial.length + lastResult.engraveRedundant.length + lastResult.enginePartial.length;

                var msg;
                if (actionableCount === 0 && reviewCount === 0) {
                    msg = "Nice! No problems found - your file looks ready to cut.";
                } else {
                    msg = "Found " + (actionableCount + reviewCount) + " thing(s) to look at:\n\n";
                    if (actionableCount > 0) {
                        msg += "CAN FIX AUTOMATICALLY - click \"Fix It\":\n" +
                            bullet(removableCount, "line", "an exact duplicate, or fully covered by another cut line") +
                            bullet(trimCount, "line", "overlapping another - will be shortened so the laser doesn't cut that stretch twice") +
                            bullet(joinCount, "spot", "where two cut lines touch end-to-end - will be joined into one continuous cut") +
                            "\n";
                    }
                    if (reviewCount > 0) {
                        msg += "NEEDS A LOOK FROM YOU (selected on the canvas):\n" +
                            bullet(lastResult.partial.length, "cut line", "overlapping another in a way that's too tricky to fix automatically") +
                            bullet(lastResult.engraveRedundant.length + lastResult.enginePartial.length, "engrave line",
                                "sitting on top of a cut line - since engraving is often intentional, we leave this for you to check");
                    }
                }
                statusText.text = msg;
                cleanBtn.setEnabled(actionableCount > 0);
            } catch (e) {
                alert("Something went wrong while checking your file:\n\n" + e.message +
                    (e.line ? "\n(line " + e.line + ")" : ""));
            }
        }

        function cleanBtn_onClick() {
            if (!lastResult) return;
            var safe = lastResult.duplicates.concat(lastResult.subsumed);
            var trimCount = lastResult.trimmed.length;
            var joinCount = lastResult.joined.length;
            if (safe.length === 0 && trimCount === 0 && joinCount === 0) return;

            var ok = confirm("Remove " + safe.length + " duplicate line(s), shorten " + trimCount +
                " overlapping line(s), and join " + joinCount + " touching line(s) into continuous cuts? " +
                "You can undo this with Cmd+Z, just like any other edit.");
            if (!ok) return;

            var removed = removeRecords(safe);
            var trimmedNow = trimRecords(lastResult.trimmed);
            var joinedNow = applyJoins(lastResult.joined);

            var reviewItems = [];
            var i;
            for (i = 0; i < lastResult.trimmed.length; i++) reviewItems.push(lastResult.trimmed[i].rec.path);
            for (i = 0; i < lastResult.joined.length; i++) reviewItems.push(lastResult.joined[i].primary.path);
            for (i = 0; i < lastResult.partial.length; i++) reviewItems.push(lastResult.partial[i].path);
            for (i = 0; i < lastResult.engraveRedundant.length; i++) reviewItems.push(lastResult.engraveRedundant[i].path);
            for (i = 0; i < lastResult.enginePartial.length; i++) reviewItems.push(lastResult.enginePartial[i].path);

            var msg = "Done! Removed " + removed + " line(s), shortened " + trimmedNow + " line(s), and joined " + joinedNow + " touching spot(s).";
            msg += reviewItems.length > 0
                ? "\n\n" + reviewItems.length + " item(s) still need a look from you - they're selected on the canvas."
                : "\n\nEverything else looks good.";
            statusText.text = msg;
            selectItems(doc, reviewItems);

            cleanBtn.setEnabled(false);
            lastResult = null;
            app.redraw();
        }

        win.center();
        win.show();
    }

    // =================================================================
    // TOOL 2: FIX RASTER CONFUSION
    // =================================================================
    //
    // The bug: sometimes - not consistently, cause unknown - a raster
    // image in the file confuses the Epilog driver into reading the
    // ENTIRE job as one big engrave and ignoring the vector cuts entirely.
    //
    // The fix: re-export every raster/placed image to a fresh PNG and
    // re-embed it in the exact same spot. This was found empirically, not
    // from a documented cause - this tool just reproduces those manual
    // steps reliably: capture each image's own pixels in isolation (every
    // other item is hidden first so overlapping cut lines can't bleed into
    // the exported file), delete the original, place the fresh PNG back at
    // the same position and size, and embed it.
    //
    // Scope: touches BOTH embedded images and linked/placed image files
    // (anything with a common raster extension - vector placed files like
    // linked AI/EPS/PDF are left alone). Runs on every image found, no
    // per-image picker. Rotated or skewed images are handled correctly too
    // - the capture bakes in whatever is visually rendered at that spot,
    // so the replacement doesn't need to re-apply any transform.
    //
    // Known limitation: re-stacking order (z-order) among the fixed images
    // relative to OTHER images is only approximate (each is brought to the
    // front of its own layer) - z-order relative to cut/engrave lines on
    // the same layer may shift slightly. Doesn't affect cut/engrave data.

    var RASTER_EXPORT_DPI = 300;
    var RASTER_EXTENSIONS = { png: 1, jpg: 1, jpeg: 1, tif: 1, tiff: 1, gif: 1, bmp: 1, psd: 1, webp: 1 };

    function collectRasterCandidates(doc) {
        var out = [];
        var i;
        for (i = 0; i < doc.rasterItems.length; i++) {
            out.push({ item: doc.rasterItems[i], kind: "embedded" });
        }
        for (i = 0; i < doc.placedItems.length; i++) {
            var pi = doc.placedItems[i];
            var ext = "";
            try {
                var name = pi.file.name;
                var dot = name.lastIndexOf(".");
                if (dot >= 0) ext = name.substring(dot + 1).toLowerCase();
            } catch (e) {
                continue; // no linked file to inspect
            }
            if (RASTER_EXTENSIONS[ext]) out.push({ item: pi, kind: "linked" });
        }
        return out;
    }

    // Renders exactly what's visible in `bounds` by hiding every other item
    // on the document first, so overlapping cut lines or other art can't
    // bleed into the exported pixels. Always restores what it hid, even if
    // the capture itself fails.
    function captureIsolated(doc, targetItem, bounds, destFile) {
        var hiddenByUs = [];
        var i;
        try {
            for (i = 0; i < doc.pageItems.length; i++) {
                var it = doc.pageItems[i];
                if (it === targetItem) continue;
                try {
                    if (!it.hidden) { it.hidden = true; hiddenByUs.push(it); }
                } catch (e) { /* skip */ }
            }
            var opts = new ImageCaptureOptions();
            opts.resolution = RASTER_EXPORT_DPI;
            opts.antiAliasing = true;
            opts.transparent = true;
            doc.imageCapture(destFile, bounds, opts);
        } finally {
            for (i = 0; i < hiddenByUs.length; i++) {
                try { hiddenByUs[i].hidden = false; } catch (e) { /* skip */ }
            }
        }
    }

    // Re-exports one raster/placed item to a fresh PNG and re-embeds it at
    // the same position, size, and layer. The capture already bakes in any
    // rotation/skew as rendered pixels, so the replacement needs no
    // transform of its own to look identical.
    function reembedOne(doc, entry) {
        var item = entry.item;
        var bounds = item.visibleBounds; // [left, top, right, bottom]
        var name = item.name;
        var layer = item.layer;
        var w = item.width, h = item.height, pos = item.position;

        var tmpFile = new File(Folder.temp + "/ahml_raster_" + (+new Date()) + "_" +
            Math.floor(Math.random() * 100000) + ".png");
        captureIsolated(doc, item, bounds, tmpFile);
        if (!tmpFile.exists) throw new Error("image capture produced no file");

        item.remove();

        var placed = doc.placedItems.add();
        placed.file = tmpFile;
        if (name) placed.name = name;
        placed.move(layer, ElementPlacement.PLACEATBEGINNING);
        placed.width = w;
        placed.height = h;
        placed.position = pos;
        placed.embed();

        try { tmpFile.remove(); } catch (e) { /* not fatal - temp file, harmless if left behind */ }
    }

    function fixRasterConfusion(doc) {
        var candidates = collectRasterCandidates(doc);
        var fixed = [];
        var failed = [];
        for (var i = 0; i < candidates.length; i++) {
            var entry = candidates[i];
            var label = entry.item.name || ("(unnamed " + entry.kind + " image)");
            try {
                reembedOne(doc, entry);
                fixed.push(label);
            } catch (e) {
                failed.push(label + ": " + e.message);
            }
        }
        return { total: candidates.length, fixed: fixed, failed: failed };
    }

    function openRasterTool(doc) {
        var folder = scriptFolder();

        var win = new Window("dialog", "Fix Raster Confusion");
        paintDark(win);
        win.orientation = "column";
        win.alignChildren = "fill";
        win.margins = 16;
        win.spacing = 9;

        var headerRow = win.add("group");
        headerRow.orientation = "row";
        headerRow.alignChildren = "center";
        headerRow.spacing = 10;
        addBadge(headerRow, folder, "badge_raster.png");
        var header = headerRow.add("statictext", undefined, "Fix raster confusion");
        header.graphics.font = ScriptUI.newFont(header.graphics.font.name, "BOLD", 17);
        colorText(header, THEME.text);

        var intro = win.add("statictext", undefined,
            "Sometimes the laser driver mistakes the whole file for one big engrave and ignores the vector cuts. Re-exporting and re-placing every image in this file usually fixes it. This only touches images - cut and engrave lines are never changed.",
            { multiline: true });
        intro.preferredSize.width = 420;
        colorText(intro, THEME.muted);

        var resultsPanel = win.add("panel", undefined, undefined);
        resultsPanel.graphics.backgroundColor = resultsPanel.graphics.newBrush(
            resultsPanel.graphics.BrushType.SOLID_COLOR, THEME.panelBg);
        resultsPanel.alignChildren = "fill";
        resultsPanel.margins = 14;

        var statusText = resultsPanel.add("statictext", undefined,
            "Click \"Fix Raster Confusion\" to scan this file.", { multiline: true });
        statusText.preferredSize.width = 400;
        statusText.preferredSize.height = 140;
        colorText(statusText, THEME.text);

        var btnRow = win.add("group");
        btnRow.orientation = "row";
        btnRow.alignChildren = "center";
        btnRow.spacing = 8;
        var fixBtn = addImageBtn(btnRow, folder, "btn_fix_raster.png", "Fix Raster Confusion", function () { fixBtn_onClick(); });
        var backBtn = addImageBtn(btnRow, folder, "btn_back.png", "Back", function () { win.close(); });
        addEscapeToClose(win);

        function fixBtn_onClick() {
            try {
                var candidates = collectRasterCandidates(doc);
                if (candidates.length === 0) {
                    statusText.text = "No images found in this file - nothing to fix.";
                    return;
                }
                var ok = confirm("This will re-export and re-place " + candidates.length +
                    " image(s) in this file. Cut and engrave lines are never touched. " +
                    "You can undo this with Cmd+Z. Continue?");
                if (!ok) return;

                var result = fixRasterConfusion(doc);
                var msg = "Fixed " + result.fixed.length + " of " + result.total + " image(s).";
                if (result.failed.length > 0) {
                    msg += "\n\n" + result.failed.length + " couldn't be fixed:\n";
                    for (var i = 0; i < result.failed.length; i++) msg += "  \u2022 " + result.failed[i] + "\n";
                }
                statusText.text = msg;
                app.redraw();
            } catch (e) {
                alert("Something went wrong while fixing images:\n\n" + e.message +
                    (e.line ? "\n(line " + e.line + ")" : ""));
            }
        }

        win.center();
        win.show();
    }

    // =================================================================
    // MAIN MENU
    // =================================================================

    // ScriptUI "dialog" windows are meant to be shown once and discarded -
    // hiding and re-showing the SAME dialog instance to "return" to it after
    // a sub-tool closes is unreliable (the second show() can be a no-op).
    // So instead of one persistent main-menu window, this builds a brand
    // new one every time the menu needs to (re)appear, in a loop that keeps
    // going until the user picks Close.
    // Dark theme colors, shared by the main menu and (loosely) matched by
    // the app icon, so the whole tool kit reads as one branded thing.
    var THEME = {
        windowBg: [0.106, 0.106, 0.122, 1],
        panelBg: [0.145, 0.145, 0.16, 1],
        text: [0.96, 0.96, 0.95, 1],
        muted: [0.66, 0.66, 0.68, 1]
    };

    function paintDark(win) {
        win.graphics.backgroundColor = win.graphics.newBrush(win.graphics.BrushType.SOLID_COLOR, THEME.windowBg);
    }

    function colorText(el, rgba) {
        el.graphics.foregroundColor = el.graphics.newPen(el.graphics.PenType.SOLID_COLOR, rgba, 1);
    }

    // This script's own folder, so the card images can be found as
    // siblings regardless of how the script was launched (Scripts menu,
    // Other Script..., or the desktop icon).
    // $.fileName only reflects this script's real path when Illustrator
    // loads the .jsx directly (File > Scripts). The desktop launchers
    // (.app / .vbs) instead read the file into a string and hand that to
    // "do javascript", which leaves $.fileName meaningless - so they
    // prepend a __LAUNCHER_FOLDER global before the script runs. Fall
    // back to $.fileName when that global isn't present.
    function scriptFolder() {
        if (typeof __LAUNCHER_FOLDER !== "undefined" && __LAUNCHER_FOLDER) {
            return new Folder(__LAUNCHER_FOLDER);
        }
        return new File($.fileName).parent;
    }

    // A big custom-image button: the whole card (background, icon, title,
    // description) is one pre-rendered PNG, since ScriptUI's native
    // buttons can't be restyled (no rounded corners, no custom color).
    // Swaps to a second "hover" image on mouse-over for a bit of life -
    // gracefully does nothing if hover events don't fire on a given
    // platform, so there's no functional risk either way.
    // Falls back to a plain text button if the card images can't be
    // found (e.g. an unusual launch path this hasn't been tested from) -
    // less pretty, but the tool keeps working instead of erroring out.
    // Deliberately a plain "image" element, not an iconbutton: on macOS,
    // ScriptUI's iconbutton draws AppKit's native hover-highlight bezel
    // behind it - a fixed oval shape sized by the OS, unrelated to the
    // image's own bounds, which looked broken behind a custom dark card
    // (confirmed live). A plain image has no such native chrome, but
    // also doesn't fire onClick as a property - it needs
    // addEventListener("click", ...) instead, confirmed working with a
    // live single-click counter test before relying on it here.
    function addCardButton(win, folder, baseName, fallbackTitle, handler) {
        try {
            var normalFile = new File(folder + "/assets/" + baseName + ".png");
            if (normalFile.exists) {
                var hoverFile = new File(folder + "/assets/" + baseName + "_hover.png");
                var img = win.add("image", undefined, normalFile);
                img.addEventListener("click", handler);
                if (hoverFile.exists) {
                    img.addEventListener("mouseover", function () { img.image = hoverFile; });
                    img.addEventListener("mouseout", function () { img.image = normalFile; });
                }
                return img;
            }
        } catch (e) { /* fall through to the plain button below */ }
        var btn = win.add("button", undefined, fallbackTitle);
        btn.onClick = handler;
        return btn;
    }

    // A small colored badge icon (matching a card's icon), used to give
    // each sub-tool dialog the same identity as its main-menu card. Silently
    // skipped if the image can't be found - purely decorative, never worth
    // failing the dialog over.
    function addBadge(container, folder, fileName) {
        try {
            var file = new File(folder + "/assets/" + fileName);
            if (file.exists) return container.add("image", undefined, file);
        } catch (e) { /* decorative only - skip if missing */ }
        return null;
    }

    // A single-state custom pill button (image + click handler), falling
    // back to a plain native button with the given title if the image
    // can't be found.
    function addImageBtn(container, folder, fileName, fallbackTitle, handler) {
        try {
            var file = new File(folder + "/assets/" + fileName);
            if (file.exists) {
                var img = container.add("image", undefined, file);
                img.addEventListener("click", handler);
                return img;
            }
        } catch (e) { /* fall through to the plain button below */ }
        var btn = container.add("button", undefined, fallbackTitle);
        btn.onClick = handler;
        return btn;
    }

    // A two-state (enabled/disabled) custom pill button. Returns an object
    // with a .setEnabled(bool) method regardless of whether it ended up as
    // a real image pair or the native-button fallback, so calling code
    // never needs to know which one it got.
    function addToggleImageBtn(container, folder, enabledFile, disabledFile, fallbackTitle, handler) {
        try {
            var enabledImg = new File(folder + "/assets/" + enabledFile);
            var disabledImg = new File(folder + "/assets/" + disabledFile);
            if (enabledImg.exists && disabledImg.exists) {
                var img = container.add("image", undefined, disabledImg);
                var isEnabled = false;
                img.addEventListener("click", function () { if (isEnabled) handler(); });
                img.setEnabled = function (v) {
                    isEnabled = v;
                    img.image = v ? enabledImg : disabledImg;
                };
                return img;
            }
        } catch (e) { /* fall through to the plain button below */ }
        var btn = container.add("button", undefined, fallbackTitle);
        btn.enabled = false;
        btn.onClick = handler;
        btn.setEnabled = function (v) { btn.enabled = v; };
        return btn;
    }

    // Custom image buttons lose the native { name: "cancel" } behavior
    // that made Escape close the dialog - restore it at the window level.
    function addEscapeToClose(win) {
        try {
            win.addEventListener("keydown", function (e) {
                if (e.keyName === "Escape") win.close();
            });
        } catch (e) { /* not critical - Escape just won't close this dialog */ }
    }

    function showMainMenu() {
        if (app.documents.length === 0) {
            alert("Open a document first.");
            return;
        }
        var doc = app.activeDocument;
        var folder = scriptFolder();

        var next = "menu";
        while (next) {
            if (next === "overlap") {
                openOverlapTool(doc);
                next = "menu";
                continue;
            }
            if (next === "raster") {
                openRasterTool(doc);
                next = "menu";
                continue;
            }

            var win = new Window("dialog", "AHML Makerplace® Laser Prep Tool Kit");
            paintDark(win);
            win.orientation = "column";
            win.alignChildren = "fill";
            win.margins = 16;
            win.spacing = 10;

            var logoImg = null;
            try {
                var logoFile = new File(folder + "/assets/logo_card.png");
                if (logoFile.exists) {
                    logoImg = win.add("image", undefined, logoFile);
                    logoImg.alignment = "center";
                }
            } catch (e) { /* decorative only - skip if missing */ }

            var header = win.add("statictext", undefined, "Laser Prep Tool Kit");
            header.alignment = "center";
            header.graphics.font = ScriptUI.newFont(header.graphics.font.name, "BOLD", 18);
            colorText(header, THEME.text);

            var intro = win.add("statictext", undefined,
                "Pick a tool below. Each one explains what it does before changing anything in your file.",
                { multiline: true });
            intro.alignment = "center";
            intro.justify = "center";
            intro.preferredSize.width = 400;
            colorText(intro, THEME.muted);

            var chosen = null;
            var open1 = addCardButton(win, folder, "card_overlap", "Fix Overlapping Lines",
                function () { chosen = "overlap"; win.close(); });
            var open2 = addCardButton(win, folder, "card_raster", "Fix Raster Confusion",
                function () { chosen = "raster"; win.close(); });

            var closeBtn = addImageBtn(win, folder, "btn_close.png", "Close", function () { chosen = null; win.close(); });
            closeBtn.alignment = "center";
            addEscapeToClose(win);

            win.center();
            win.show();

            next = chosen;
        }
    }

    showMainMenu();

})();
