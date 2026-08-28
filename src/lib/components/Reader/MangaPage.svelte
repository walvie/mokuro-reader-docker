<script lang="ts">
  import type { Page } from '$lib/types';
  import TextBoxes from './TextBoxes.svelte';
  import { Spinner } from 'flowbite-svelte';

  interface ContextMenuData {
    x: number;
    y: number;
    lines: string[];
    imgElement: HTMLElement | null;
    textBox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] for initial crop
  }

  interface Props {
    page: Page;
    src?: File | null;
    cachedUrl?: string | null;
    volumeUuid: string;
    /** 0-based page index within the volume */
    pageIndex?: number;
    /** Force text visibility (for placeholder/missing pages) */
    forceVisible?: boolean;
    /**
     * True when this page is known to be permanently unavailable (e.g. a
     * corrupt/missing source image on a server-library volume). Suppresses
     * the streaming-in loading indicator below, which would otherwise spin
     * forever for a page whose image is never coming.
     */
    isMissing?: boolean;
    /** Callback when context menu should be shown */
    onContextMenu?: (data: ContextMenuData) => void;
  }

  let {
    page,
    src,
    cachedUrl,
    volumeUuid,
    pageIndex,
    forceVisible = false,
    isMissing = false,
    onContextMenu
  }: Props = $props();

  let url = $state('');

  // Use cached URL if available, otherwise create blob URL
  $effect(() => {
    let currentBlobUrl: string | null = null;

    if (cachedUrl) {
      // Use pre-decoded cached URL (no cleanup needed, managed by cache)
      url = `url(${cachedUrl})`;
    } else if (src) {
      // Fallback: create new blob URL
      currentBlobUrl = URL.createObjectURL(src);
      url = `url(${currentBlobUrl})`;
    } else {
      url = '';
    }

    // Cleanup function runs on effect re-run or component unmount
    return () => {
      // Only revoke if we created it (not from cache)
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  });

  // No image yet, but one is still expected (e.g. a server-library volume
  // whose pages are streaming in over HTTP) — distinct from isMissing, where
  // no image is ever coming and a spinner would just spin forever.
  let showLoading = $derived(!url && !isMissing);
</script>

<div
  draggable="false"
  data-page-index={pageIndex}
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  style:background-image={url}
  style:background-size="contain"
  style:background-repeat="no-repeat"
  style:background-position="center"
  class="relative"
>
  {#if showLoading}
    <div class="absolute inset-0 flex items-center justify-center" data-testid="page-loading">
      <Spinner size="8" color="blue" />
    </div>
  {/if}
  <TextBoxes
    {page}
    src={src ?? undefined}
    {volumeUuid}
    {pageIndex}
    {forceVisible}
    {onContextMenu}
  />
</div>
