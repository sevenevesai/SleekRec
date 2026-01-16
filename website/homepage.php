<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Seveneves AI</title>
<style>
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    body {
        background: #fafafa;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    .universe {
        position: fixed;
        width: 100%;
        height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .logo-container {
        position: relative;
        z-index: 10;
    }

    .logo {
        width: 200px;
        height: 200px;
        position: relative;
        z-index: 2;
        cursor: pointer;
        transition: transform 0.3s ease;
    }

    .logo:hover {
        transform: scale(1.05);
    }

    /* Orbiting Products */
    .orbit-container {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
    }

    .orbit {
        position: absolute;
        border: 1px solid rgba(17, 17, 17, 0.06);
        border-radius: 50%;
        transition: opacity 0.3s ease;
    }

    .product {
        position: absolute;
        pointer-events: all;
        will-change: transform;
        -webkit-backface-visibility: hidden;
        backface-visibility: hidden;
        -webkit-transform: translateZ(0);
        transform: translateZ(0);
    }

    .product-inner {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: transform 0.25s ease;
        will-change: transform;
        transform: translateZ(0);
    }

    .product-inner img {
        transition: transform 0.25s ease;
        image-rendering: -webkit-optimize-contrast;
        image-rendering: smooth;
        -webkit-backface-visibility: hidden;
        backface-visibility: hidden;
    }

    .product.hovered .product-inner,
    .product:hover .product-inner {
        transform: scale(1.2) translateZ(0);
    }

    .product.hovered,
    .product:hover {
        z-index: 100;
    }

    .product.hovered .product-inner img,
    .product:hover .product-inner img {
        transform: scale(1.05);
    }

    .product-info {
        position: absolute;
        bottom: -28px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: white;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: none;
    }

    .product.hovered .product-info,
    .product:hover .product-info {
        opacity: 1;
    }

    /* Canvas styles */
    #rotatingCircleCanvas {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
    }

    #snowCanvas {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }

    /* Responsive */
    @media (max-width: 768px) {
        .logo {
            width: 120px;
            height: 120px;
        }
    }

    @media (max-width: 480px) {
        .logo {
            width: 80px;
            height: 80px;
        }
    }
</style>
<link rel="icon" href="assets/images/logo64.ico" type="image/x-icon">
</head>
<body>
<div class="universe">
    <div class="orbit-container" id="orbitContainer"></div>
    <div class="logo-container">
        <img src="assets/images/logo250.png" alt="Seveneves Logo" class="logo" id="logo">
        <canvas id="rotatingCircleCanvas"></canvas>
    </div>
</div>
<canvas id="snowCanvas"></canvas>

<script>
    // Canvas setup
    const canvas = document.getElementById('snowCanvas');
    const ctx = canvas.getContext('2d');
    const circleCanvas = document.getElementById('rotatingCircleCanvas');
    const circleCtx = circleCanvas.getContext('2d');
    const circleCanvasBuffer = 10;
    const circleCanvasRadius = 180;
    const dissolveFlakes = [];

    let snowflakes = [];
    let angle = 0;
    let lastOrbitTime = performance.now();

    // Orbital configuration - like a solar system
    // Inner orbits move faster, outer orbits slower (Kepler's laws)
    const orbits = [
        { radius: 230, speed: 0.00018, products: [] },  // Inner - faster
        { radius: 340, speed: 0.00008, products: [] }   // Outer - slower
    ];

    // Product configuration
    const products = [
        // Inner orbit - 2 planets, opposite sides
        {
            name: 'Capsula',
            icon: '/capsula/icons/32.png',
            url: '/capsula',
            orbitIndex: 0,
            phase: 0,
            size: 44
        },
        {
            name: 'Pixel Assets',
            icon: '/pixels/icons/32.png',
            url: '/pixels',
            orbitIndex: 0,
            phase: Math.PI,
            size: 40
        },
        // Outer orbit - 3 planets, evenly spaced
        {
            name: 'Graal RC',
            icon: '/graalrc/icon-1.png',
            url: '/graalrc',
            orbitIndex: 1,
            phase: 0,
            size: 48
        },
        {
            name: 'BitGit',
            icon: '/bitgit/icon.png',
            url: '/bitgit',
            orbitIndex: 1,
            phase: (2 * Math.PI) / 3,
            size: 46
        },
        {
            name: 'SleekRec',
            icon: '/sleekrec/icon.png',
            url: '/sleekrec',
            orbitIndex: 1,
            phase: (4 * Math.PI) / 3,
            size: 44
        }
    ];

    // Assign products to their orbits
    products.forEach(p => orbits[p.orbitIndex].products.push(p));

    // Create orbiting products
    function createOrbits() {
        const container = document.getElementById('orbitContainer');

        // Create orbit rings
        orbits.forEach((orbit, i) => {
            const orbitDiv = document.createElement('div');
            orbitDiv.className = 'orbit';
            orbitDiv.style.width = `${orbit.radius * 2}px`;
            orbitDiv.style.height = `${orbit.radius * 2}px`;
            orbitDiv.style.left = `${-orbit.radius}px`;
            orbitDiv.style.top = `${-orbit.radius}px`;
            container.appendChild(orbitDiv);
            orbit.angle = Math.random() * Math.PI * 2; // Random start position
        });

        // Create product elements
        products.forEach(product => {
            const productDiv = document.createElement('div');
            productDiv.className = 'product';
            productDiv.style.width = `${product.size}px`;
            productDiv.style.height = `${product.size}px`;

            const imgSize = Math.round(product.size * 0.7);
            productDiv.innerHTML = `
                <div class="product-inner">
                    <img src="${product.icon}" alt="${product.name}" style="width:${imgSize}px;height:${imgSize}px;">
                </div>
                <span class="product-info">${product.name}</span>
            `;
            productDiv.onclick = () => window.location.href = product.url;

            // Hover persistence logic
            productDiv.addEventListener('mouseenter', () => {
                clearHoverPersistence();
                hoveredProduct = product;
            });

            productDiv.addEventListener('mouseleave', () => {
                if (hoveredProduct === product) {
                    productDiv.classList.add('hovered');
                    startHoverPersistence(product);
                }
            });

            container.appendChild(productDiv);
            product.element = productDiv;
        });
    }

    // Hover persistence system
    let hoveredProduct = null;
    let hoverTimeout = null;
    let lastMousePos = { x: 0, y: 0 };
    const HOVER_PERSIST_DURATION = 1200; // ms
    const MOUSE_MOVE_THRESHOLD = 8; // px

    function startHoverPersistence(product) {
        lastMousePos = { x: window.mouseX || 0, y: window.mouseY || 0 };
        hoverTimeout = setTimeout(() => {
            clearHoverPersistence();
        }, HOVER_PERSIST_DURATION);
    }

    function clearHoverPersistence() {
        if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
        }
        if (hoveredProduct && hoveredProduct.element) {
            hoveredProduct.element.classList.remove('hovered');
        }
        hoveredProduct = null;
    }

    // Track mouse position and movement
    document.addEventListener('mousemove', (e) => {
        window.mouseX = e.clientX;
        window.mouseY = e.clientY;

        // If we have a persisted hover and mouse moved significantly, clear it
        if (hoveredProduct && hoverTimeout) {
            const dx = e.clientX - lastMousePos.x;
            const dy = e.clientY - lastMousePos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > MOUSE_MOVE_THRESHOLD) {
                clearHoverPersistence();
            }
        }
    });

    // Animate products in orbits
    function animateOrbits() {
        const now = performance.now();
        const delta = Math.min(now - lastOrbitTime, 50);
        lastOrbitTime = now;

        orbits.forEach(orbit => {
            orbit.angle += delta * orbit.speed;

            orbit.products.forEach(product => {
                const currentAngle = orbit.angle + product.phase;
                const x = Math.cos(currentAngle) * orbit.radius;
                const y = Math.sin(currentAngle) * orbit.radius;
                const offset = product.size / 2;

                product.element.style.transform = `translate3d(${x - offset}px, ${y - offset}px, 0) rotate(0.02deg)`;
            });
        });

        requestAnimationFrame(animateOrbits);
    }

    // Initialize orbits
    createOrbits();
    animateOrbits();

    // Canvas sizing
    function setCanvasSize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    window.addEventListener('resize', setCanvasSize);
    setCanvasSize();

    function setCircleCanvasSize() {
        const displaySize = (circleCanvasRadius * 2) + circleCanvasBuffer;
        const resolutionMultiplier = 2;
        circleCanvas.width = displaySize * resolutionMultiplier;
        circleCanvas.height = displaySize * resolutionMultiplier;
        circleCanvas.style.width = `${displaySize}px`;
        circleCanvas.style.height = `${displaySize}px`;
        circleCtx.setTransform(resolutionMultiplier, 0, 0, resolutionMultiplier, 0, 0);
    }

    function drawRotatingCircle() {
        circleCtx.clearRect(0, 0, circleCanvas.width, circleCanvas.height);
        const centerX = circleCanvas.width / 2 / 2;
        const centerY = circleCanvas.height / 2 / 2;

        circleCtx.save();
        circleCtx.translate(centerX, centerY);
        circleCtx.rotate(angle);
        circleCtx.translate(-centerX, -centerY);

        const lineThickness = 4;
        const segments = 12;
        const gapAngle = Math.PI / 12;

        circleCtx.lineWidth = lineThickness;
        circleCtx.strokeStyle = '#111';
        circleCtx.lineCap = 'round';

        for (let i = 0; i < segments; i++) {
            const startAngle = (i * 2 * Math.PI) / segments;
            const endAngle = startAngle + (2 * Math.PI / segments) - gapAngle;

            circleCtx.beginPath();
            circleCtx.arc(centerX, centerY, circleCanvasRadius, startAngle, endAngle);
            circleCtx.stroke();
        }

        circleCtx.restore();
        angle += 0.0004;
        requestAnimationFrame(drawRotatingCircle);
    }

    setCircleCanvasSize();
    drawRotatingCircle();
</script>
</body>
</html>