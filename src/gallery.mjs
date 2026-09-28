// Development-only entry: screen.css is linked from gallery.html so the dev server serves it as a file.
import { renderGallery } from './gallery-view.mjs';

void renderGallery(document.getElementById('gallery'));
