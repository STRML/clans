import * as THREE from 'three';
import type { KatabaticAssets } from './assets.js';

export function fogColor(data: KatabaticAssets): THREE.Color {
  const [r, g, b] = data.scene.sky.fogColor;
  return new THREE.Color(r, g, b);
}

export function buildTerrainGeometry(data: KatabaticAssets): THREE.BufferGeometry {
  const { gridSize, squareSize, origin, heightScale } = data.terrain;
  const positions = new Float32Array(gridSize * gridSize * 3);
  const uvs = new Float32Array(gridSize * gridSize * 2);
  for (let row = 0; row < gridSize; row += 1)
    for (let col = 0; col < gridSize; col += 1) {
      const point = row * gridSize + col;
      positions.set(
        [
          origin.x + col * squareSize,
          origin.y + (data.heights[point] ?? 0) / heightScale,
          origin.z - row * squareSize,
        ],
        point * 3,
      );
      uvs.set([col / (gridSize - 1), row / (gridSize - 1)], point * 2);
    }
  const indices: number[] = [];
  for (let row = 0; row < gridSize - 1; row += 1)
    for (let col = 0; col < gridSize - 1; col += 1) {
      const a = row * gridSize + col,
        b = a + 1,
        c = a + gridSize,
        d = c + 1;
      if (((col ^ row) & 1) === 0) indices.push(a, c, d, a, d, b);
      else indices.push(a, c, b, b, c, d);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export async function createTerrain(data: KatabaticAssets): Promise<THREE.Mesh> {
  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(
    data.terrain.layers.map(async (layer) => loader.loadAsync(`/katabatic/${layer.texture}`)),
  );
  textures.forEach((texture) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
  });
  const alpha = data.alphaMaps.map((bytes) => {
    const texture = new THREE.DataTexture(
      bytes,
      data.terrain.gridSize,
      data.terrain.gridSize,
      THREE.RedFormat,
    );
    texture.needsUpdate = true;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  });
  const material = new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      map0: { value: textures[0] },
      map1: { value: textures[1] },
      map2: { value: textures[2] },
      map3: { value: textures[3] },
      alpha0: { value: alpha[0] },
      alpha1: { value: alpha[1] },
      alpha2: { value: alpha[2] },
      alpha3: { value: alpha[3] },
      fogColor: { value: fogColor(data) },
      fogNear: { value: data.scene.sky.fogDistance },
      fogFar: { value: data.scene.sky.visibleDistance },
    },
    vertexShader: `varying vec2 vUv; varying float vFogDepth; void main(){vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.0);vFogDepth=-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `uniform sampler2D map0,map1,map2,map3,alpha0,alpha1,alpha2,alpha3;uniform vec3 fogColor;uniform float fogNear,fogFar;varying vec2 vUv;varying float vFogDepth;void main(){vec2 tile=vUv*64.0;vec4 w=vec4(texture2D(alpha0,vUv).r,texture2D(alpha1,vUv).r,texture2D(alpha2,vUv).r,texture2D(alpha3,vUv).r);w/=max(dot(w,vec4(1.0)),0.0001);vec3 color=texture2D(map0,tile).rgb*w.x+texture2D(map1,tile).rgb*w.y+texture2D(map2,tile).rgb*w.z+texture2D(map3,tile).rgb*w.w;float fog=smoothstep(fogNear,fogFar,vFogDepth);gl_FragColor=vec4(mix(color,fogColor,fog),1.0);}`,
  });
  const mesh = new THREE.Mesh(buildTerrainGeometry(data), material);
  mesh.receiveShadow = true;
  mesh.name = 'katabatic-terrain';
  return mesh;
}

export function addEnvironment(target: THREE.Scene, data: KatabaticAssets): void {
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x5b7899) },
      bottom: { value: new THREE.Color(0xd7e2e8) },
    },
    vertexShader: `varying vec3 world;void main(){world=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform vec3 top,bottom;varying vec3 world;void main(){float h=clamp(normalize(world).y*0.5+0.5,0.0,1.0);gl_FragColor=vec4(mix(bottom,top,h),1.0);}`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMaterial);
  sky.name = 'sky'; // Task 10 moves this mesh to the camera position every frame.
  target.add(sky);
  const sun = new THREE.DirectionalLight(
    new THREE.Color(...(data.scene.sun.color.slice(0, 3) as [number, number, number])),
    1,
  );
  sun.position.fromArray(data.scene.sun.direction).multiplyScalar(-300);
  sun.castShadow = true;
  target.add(sun);
  target.add(
    new THREE.AmbientLight(
      new THREE.Color(...(data.scene.sun.ambient.slice(0, 3) as [number, number, number])),
      1,
    ),
  );
  target.fog = new THREE.Fog(
    fogColor(data),
    data.scene.sky.fogDistance,
    data.scene.sky.visibleDistance,
  );
  target.background = fogColor(data);
}
