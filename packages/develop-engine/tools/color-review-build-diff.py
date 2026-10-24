"""Pixel difference between two renderer builds on the development teachers (#27).

Development-only; never opens sealed independent data. Requires the colorcheck
Python environment (numpy/Pillow/OpenCV).

  color-review-build-diff.py --repo <checkout> --work <private-outside-repo> \
      --baseline-bin <niho-develop-render A> --candidate-bin <niho-develop-render B> \
      [--engine niho-13] [--candidate-engine niho-14] [--workers 6]

`--candidate-engine` (default: `--engine`) renders the candidate with another
engine, so one build can compare two engines (#89: niho-13 against niho-14).

Every teacher input (`<work>/data/teachers*/inputs/<scene>__neutral.jpg`, blank
ones excluded) is rendered by both builds at a 2048px long edge with each
bundled preset (the product converter, NIHO standard look) and each relative
white balance below, and the two renders are compared like the teacher gate
(long edge 1500, blur 2, flat pixels, alignment; CIEDE2000 mean / p99 / max).
Only the anonymous aggregate (`build-diff-summary-sanitized.json`) is meant
for publication; rows, renders and paths stay in the work directory.
"""
import argparse, concurrent.futures, hashlib, json, subprocess, sys, time
from pathlib import Path

PRESETS = ['preset_bluesky2', 'preset_pastel', 'preset_colorful']
WHITE_BALANCES = {
    'tp30': (30, 0), 'tm30': (-30, 0), 'gp20': (0, 20), 'gm20': (0, -20), 'warm': (30, 20),
}


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def render(binary, settings, source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    r = subprocess.run([str(binary), 'render', '--settings', str(settings), '--out', str(destination),
                        '--raster', str(source), '--max-dimension', '2048'], capture_output=True, text=True)
    if r.returncode or not destination.is_file():
        raise RuntimeError(f'render failed status={r.returncode}')


def run_job(job):
    repo, work, baseline, candidate, cohort, scene, preset, wb = job
    repo, work = Path(repo), Path(work)
    source = work / 'data' / cohort / 'inputs' / f'{scene}__neutral.jpg'
    settings = work / 'build-diff' / 'settings' / f'{preset}__{wb}.json'
    candidate_settings = work / 'build-diff' / 'settings' / f'{preset}__{wb}__candidate.json'
    out = work / 'build-diff' / 'renders'
    a = out / 'baseline' / cohort / f'{scene}__{preset}__{wb}.png'
    b = out / 'candidate' / cohort / f'{scene}__{preset}__{wb}.png'
    render(baseline, settings, source, a)
    render(candidate, candidate_settings, source, b)
    sys.path.insert(0, str(repo / 'packages/develop-engine/tools/colorcheck'))
    from colorcheck.compare import run_compare
    if digest(a) == digest(b):
        d = {'mean': 0.0, 'p99': 0.0, 'max': 0.0}
        flat = None
    else:
        result = run_compare(str(a), str(b), size=1500, blur=2, do_align=True)
        d = result['metrics']['deltaE00']
        flat = result['metrics']['flatFraction']
    return {'cohort': cohort, 'scene': scene, 'preset': preset, 'whiteBalance': wb,
            'mean': d['mean'], 'p99': d['p99'], 'max': d['max'], 'flatFraction': flat,
            'identical': digest(a) == digest(b)}


def aggregate(rows):
    if not rows:
        return {}
    return {'pairs': len(rows), 'identical': sum(r['identical'] for r in rows),
            'meanOfMeans': sum(r['mean'] for r in rows) / len(rows), 'maxMean': max(r['mean'] for r in rows),
            'meanOfP99': sum(r['p99'] for r in rows) / len(rows), 'maxP99': max(r['p99'] for r in rows),
            'maxMax': max(r['max'] for r in rows),
            # The #27 rule for an analysis that may move pixels: mean <= 0.3 and p99 <= 1.5 per pair.
            'meanOver0_3': sum(r['mean'] > 0.3 for r in rows), 'p99Over1_5': sum(r['p99'] > 1.5 for r in rows)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, type=Path)
    ap.add_argument('--work', required=True, type=Path)
    ap.add_argument('--baseline-bin', required=True, type=Path)
    ap.add_argument('--candidate-bin', required=True, type=Path)
    ap.add_argument('--engine', default='niho-13')
    ap.add_argument('--candidate-engine', default=None)
    ap.add_argument('--workers', default=4, type=int)
    args = ap.parse_args()
    candidate_engine = args.candidate_engine or args.engine
    if args.work.resolve() == args.repo.resolve() or args.repo.resolve() in args.work.resolve().parents:
        raise SystemExit('Private inputs/outputs must be outside the repository')
    settings_root = args.work / 'build-diff' / 'settings'
    settings_root.mkdir(parents=True, exist_ok=True)
    example = args.repo / 'packages/develop-engine/target/release/examples/render_rgba'
    public_input = args.repo / 'packages/develop-engine/fixtures/golden/input/saturated-blue.png'
    for preset in PRESETS:
        base = settings_root / f'{preset}-base.json'
        scratch = settings_root / 'scratch.rgba'
        base.unlink(missing_ok=True)
        scratch.unlink(missing_ok=True)
        subprocess.run([str(example), str(public_input), 'niho-' + preset.removeprefix('preset_'), '32',
                        str(scratch), str(base)], check=True, capture_output=True)
        value = json.loads(base.read_text())
        value['look'] = 'niho-standard-1'
        value['engine'] = args.engine
        for wb, (temperature, tint) in WHITE_BALANCES.items():
            value['whiteBalance'] = {'mode': 'relative'}
            value['relativeTemperature'] = temperature
            value['relativeTint'] = tint
            value['engine'] = args.engine
            (settings_root / f'{preset}__{wb}.json').write_text(json.dumps(value))
            value['engine'] = candidate_engine
            (settings_root / f'{preset}__{wb}__candidate.json').write_text(json.dumps(value))
    sys.path.insert(0, str(args.repo / 'packages/develop-engine/tools/calibrate'))
    from fit_niho6_response import blank_input
    jobs, counts, skipped = [], {}, 0
    for cohort in ['teachers', 'teachers2']:
        root = args.work / 'data' / cohort
        manifest = json.loads((root / 'manifest.json').read_text())
        if manifest.get('sealed'):
            raise RuntimeError('sealed cohort is forbidden for this development runner')
        n = 0
        for scene in manifest['scenes']:
            name = scene['scene']
            if blank_input(root / 'inputs' / f'{name}__neutral.jpg'):
                skipped += 1
                continue
            n += 1
            for preset in PRESETS:
                for wb in WHITE_BALANCES:
                    jobs.append((str(args.repo), str(args.work), str(args.baseline_bin), str(args.candidate_bin),
                                 cohort, name, preset, wb))
        counts[cohort] = n
    start = time.monotonic()
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(run_job, jobs))
    (args.work / 'build-diff-rows-private.json').write_text(json.dumps(rows, indent=2))
    summary = {
        'kind': 'development-teachers-build-difference-not-independent',
        'engine': args.engine,
        'candidateEngine': candidate_engine,
        'baselineSha256': digest(args.baseline_bin),
        'candidateSha256': digest(args.candidate_bin),
        'cohortCounts': counts, 'blankExcluded': skipped, 'independentImagesRead': 0,
        'protocol': {'renderLongEdge': 2048, 'compareLongEdge': 1500, 'blur': 2, 'flatPixels': True,
                     'alignment': True, 'presets': PRESETS,
                     'whiteBalances': {k: {'relativeTemperature': t, 'relativeTint': g}
                                       for k, (t, g) in WHITE_BALANCES.items()}},
        'all': aggregate(rows),
        'byWhiteBalance': {wb: aggregate([r for r in rows if r['whiteBalance'] == wb]) for wb in WHITE_BALANCES},
        'byPreset': {p: aggregate([r for r in rows if r['preset'] == p]) for p in PRESETS},
        'byWhiteBalanceAndPreset': {f'{wb}/{p}': aggregate([r for r in rows if r['whiteBalance'] == wb
                                                             and r['preset'] == p])
                                    for wb in WHITE_BALANCES for p in PRESETS},
        'seconds': time.monotonic() - start,
    }
    (args.work / 'build-diff-summary-sanitized.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary['all'], indent=2))


if __name__ == '__main__':
    main()
