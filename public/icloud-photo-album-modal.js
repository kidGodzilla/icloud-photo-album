(function() {
  'use strict';

  // Get the base URL from the script src or use current origin
  function getBaseUrl() {
    const scripts = document.getElementsByTagName('script');
    for (let script of scripts) {
      if (script.src && script.src.includes('icloud-photo-album-modal.js')) {
        const url = new URL(script.src);
        return url.origin;
      }
    }
    return window.location.origin;
  }

  const baseUrl = getBaseUrl();
  let modal = null;
  let iframe = null;
  let closeBtn = null;

  function createModal() {
    if (modal) return modal;

    // Create modal container
    modal = document.createElement('div');
    modal.id = 'icloud-album-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.9);
      z-index: 999999;
      display: none;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    // Create close button (matching lightbox close button styles)
    closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    
    // Create style element for responsive sizing matching lightbox
    const style = document.createElement('style');
    style.textContent = `
      #icloud-album-modal-close {
        position: absolute;
        top: 20px;
        right: 20px;
        background: rgba(255, 255, 255, 0.1);
        border: none;
        color: white;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.2s ease, background 0.2s ease;
        backdrop-filter: blur(10px);
        z-index: 1000000;
        font-family: Arial, sans-serif !important;
        padding: 0;
        margin: 0;
        line-height: 1;
        box-sizing: border-box;
      }
      #icloud-album-modal-close:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      @media (max-width: 768px) {
        #icloud-album-modal-close {
          top: 10px;
          right: 10px;
          width: 36px;
          height: 36px;
          font-size: 20px;
        }
      }
    `;
    document.head.appendChild(style);
    
    closeBtn.id = 'icloud-album-modal-close';
    closeBtn.onclick = closeModal;

    // Create iframe
    iframe = document.createElement('iframe');
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: #1a1a1a;
    `;

    modal.appendChild(closeBtn);
    modal.appendChild(iframe);
    document.body.appendChild(modal);

    // Close on background click
    modal.onclick = (e) => {
      if (e.target === modal) {
        closeModal();
      }
    };

    // Close on Escape key (when modal has focus)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') {
        closeModal();
      }
    });

    // Listen for messages from iframe
    window.addEventListener('message', (e) => {
      if (!e.data || !modal || modal.style.display === 'none') return;
      
      if (e.data.type === 'icloud-album-close') {
        closeModal();
      } else if (e.data.type === 'icloud-album-lightbox-open' && closeBtn) {
        // Hide modal close button when lightbox is open
        closeBtn.style.opacity = '0';
        closeBtn.style.pointerEvents = 'none';
      } else if (e.data.type === 'icloud-album-lightbox-close' && closeBtn) {
        // Show modal close button when lightbox is closed
        closeBtn.style.opacity = '1';
        closeBtn.style.pointerEvents = 'auto';
      }
    });

    return modal;
  }

  function openModal(token) {
    if (!token) {
      console.error('Album token is required');
      return;
    }

    createModal();
    const albumUrl = `${baseUrl}/${token}`;
    iframe.src = albumUrl;
    
    modal.style.display = 'block';
    // Trigger animation
    requestAnimationFrame(() => {
      modal.style.opacity = '1';
    });
    
    // Prevent body scroll
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!modal) return;
    
    modal.style.opacity = '0';
    setTimeout(() => {
      modal.style.display = 'none';
      iframe.src = '';
      document.body.style.overflow = '';
    }, 300);
  }

  // Expose global function
  window.icloudAlbumModal = openModal;
})();

