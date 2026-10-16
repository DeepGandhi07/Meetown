"""One-time helper to install selected Argos Translate language pairs.

Usage: python install_argos_pairs.py de-en en-de
This downloads open-source model packages during setup; translation at runtime is local.
For fully offline deployment, install .argosmodel files manually instead.
"""
import sys
import argostranslate.package

pairs = sys.argv[1:] or ["de-en", "en-de"]
argostranslate.package.update_package_index()
packages = argostranslate.package.get_available_packages()

for pair in pairs:
    try:
        source, target = pair.split("-", 1)
    except ValueError as exc:
        raise SystemExit(f"Invalid pair '{pair}'. Use codes like de-en.") from exc
    package = next((p for p in packages if p.from_code == source and p.to_code == target), None)
    if package is None:
        print(f"No direct Argos package found for {source}->{target}; skipping.")
        continue
    print(f"Installing {source}->{target} ...")
    package_path = package.download()
    argostranslate.package.install_from_path(package_path)
    print(f"Installed {source}->{target}")
