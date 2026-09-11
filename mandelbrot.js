'use strict';
var canvas, context;
var map;
var config;
var activeRendering = 0;
var colourBlack = { red: 0, green: 0, blue: 0, alpha: 1 };
var thumbnailSize = 96;

// Custom value-adjuster widgets (valueAdjuster.js) that replaced the plain
// number inputs / range sliders for these fields.
var valueAdjusters = {};

// Set while config values are being pushed into those widgets, so their
// onAdjust callbacks don't fire a redraw for every single field.
var suppressAdjusterSync = false;

var defaultConfig = {
	"map": {
		"width": 4.1,
		"height": 4.1,
		"x": 0,
		"y": 0,
		"accuracy": 256
	},
	"palette": {
		"colourWavePeriod": 64,
		"red": { "offset": -.47, "stagger": 0, "period": 1 },
		"green": { "offset": 0, "stagger": 0, "period": 1 },
		"blue": { "offset": .7, "stagger": 0, "period": 1 },
		"master": { "offset": 0, "stagger": 0 },
		staggerMask: { red: "10", green: "10", blue: "10" }
	},
	"options": {
		calculationFlags: { iterations: 1, displacement: 0, rotation: 0, displacementXOR: 0, polarCoordXOR: 0 },
		coefficients: { iterations: 1, displacement: 1, rotation: 1, displacementXOR: 1, polarCoordXOR: 1 },
		"endCondition": "",
		"maxRadius": 4,
		"staggerBefore" : 1,
		"staggerAfter" : 0,
		"recursionDepth": 1,
		"countOffset": 0
	}
};

// Order of values for the compact URL format.
// Keep this list exactly as-is; if you add fields later, increment the version
// (e.g., 'v2') and append new fields at the end.
var CONFIG_ORDER = [
	'map.x', 'map.y', 'map.width', 'map.height', 'map.accuracy',
	'palette.colourWavePeriod',
	'palette.red.offset', 'palette.red.stagger', 'palette.red.period',
	'palette.green.offset', 'palette.green.stagger', 'palette.green.period',
	'palette.blue.offset', 'palette.blue.stagger', 'palette.blue.period',
	'palette.master.offset', 'palette.master.stagger',
	'palette.staggerMask.red', 'palette.staggerMask.green', 'palette.staggerMask.blue',
	'options.calculationFlags.iterations', 'options.calculationFlags.displacement',
	'options.calculationFlags.rotation', 'options.calculationFlags.displacementXOR',
	'options.calculationFlags.polarCoordXOR',
	'options.coefficients.iterations', 'options.coefficients.displacement',
	'options.coefficients.rotation', 'options.coefficients.displacementXOR',
	'options.coefficients.polarCoordXOR',
	'options.endCondition',
	'options.maxRadius',
	'options.staggerBefore',
	'options.staggerAfter',
	'options.recursionDepth',
	'options.countOffset'
];

// Helper to get/set nested properties by dot‑separated path.
function getNestedValue(obj, path) {
	var parts = path.split('.');
	var current = obj;
	for (var i = 0; i < parts.length; i++) {
		if (current[parts[i]] === undefined) return undefined;
		current = current[parts[i]];
	}
	return current;
}

function setNestedValue(obj, path, value) {
	var parts = path.split('.');
	var current = obj;
	for (var i = 0; i < parts.length - 1; i++) {
		if (!current[parts[i]]) current[parts[i]] = {};
		current = current[parts[i]];
	}
	current[parts[parts.length - 1]] = value;
}

// Serialise the full config to a compact string.
function serializeConfig(config) {
	var values = CONFIG_ORDER.map(function(path) {
		return String(getNestedValue(config, path));
	});
	return 'v1,' + values.join(',');
}

// Deserialise from a 'v1,...' string.
function deserializeConfig(str) {
	if (!str.startsWith('v1,')) return null;
	var parts = str.split(',');
	if (parts.length !== CONFIG_ORDER.length + 1) return null;

	var cfg = JSON.parse(JSON.stringify(defaultConfig));
	// Fields that must be kept as strings (not parsed as numbers)
	var stringFields = [
		'options.endCondition',
		'palette.staggerMask.red',
		'palette.staggerMask.green',
		'palette.staggerMask.blue'
	];

	for (var i = 0; i < CONFIG_ORDER.length; i++) {
		var path = CONFIG_ORDER[i];
		var val = parts[i + 1];
		var parsed;
		if (stringFields.indexOf(path) !== -1) {
			parsed = val;	 // keep as string
		} else {
			// Try to parse as number; if it fails, fall back to string (shouldn't happen)
			var num = parseFloat(val);
			parsed = isNaN(num) ? val : num;
		}
		setNestedValue(cfg, path, parsed);
	}
	return cfg;
}

// ============================================================================
// IndexedDB wrapper for renderings (configs + thumbnails)
// ============================================================================

var DB_NAME = 'MandelbrotExplorer';
var DB_VERSION = 1;
var STORE_NAME = 'renderings';

function openDB() {
	return new Promise((resolve, reject) => {
		var request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = function(e) {
			var db = e.target.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
			}
		};
		request.onsuccess = function(e) {
			resolve(e.target.result);
		};
		request.onerror = function(e) {
			reject(e.target.error);
		};
	});
}

function getAllRenderingsFromDB(db) {
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_NAME, 'readonly');
		var store = tx.objectStore(STORE_NAME);
		var request = store.getAll();
		request.onsuccess = function() {
			resolve(request.result);
		};
		request.onerror = function() {
			reject(request.error);
		};
	});
}

function addRenderingToDB(db, config, thumbnailBlob, thumbnailWidth, thumbnailHeight) {
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_NAME, 'readwrite');
		var store = tx.objectStore(STORE_NAME);
		var record = {
			config: config,
			thumbnailBlob: thumbnailBlob || null,
			thumbnailWidth: thumbnailWidth || 0,
			thumbnailHeight: thumbnailHeight || 0
		};
		var request = store.add(record);
		request.onsuccess = function() {
			resolve(request.result); // the auto-incremented id
		};
		request.onerror = function() {
			reject(request.error);
		};
	});
}

function updateRenderingInDB(db, id, updates) {
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_NAME, 'readwrite');
		var store = tx.objectStore(STORE_NAME);
		var request = store.get(id);
		request.onsuccess = function() {
			var record = request.result;
			if (!record) { reject(new Error('Record not found')); return; }
			Object.assign(record, updates);
			var putRequest = store.put(record);
			putRequest.onsuccess = function() {
				resolve();
			};
			putRequest.onerror = function() {
				reject(putRequest.error);
			};
		};
		request.onerror = function() {
			reject(request.error);
		};
	});
}

function deleteRenderingFromDB(db, id) {
	return new Promise((resolve, reject) => {
		var tx = db.transaction(STORE_NAME, 'readwrite');
		var store = tx.objectStore(STORE_NAME);
		var request = store.delete(id);
		request.onsuccess = function() {
			resolve();
		};
		request.onerror = function() {
			reject(request.error);
		};
	});
}

// Migration helper: read from localStorage and import into IndexedDB
function migrateFromLocalStorage(db, renderings) {
	if (!renderings || renderings.length === 0) return Promise.resolve();
	var promises = renderings.map(function(rendering) {
		// apply any needed updates (same as updateOldStoredData but on a single object)
		migrateSingleRendering(rendering);
		// add without thumbnail
		return addRenderingToDB(db, rendering, null, 0, 0);
	});
	return Promise.all(promises);
}

// Apply schema updates to a single rendering object (copied from updateOldStoredData)
function migrateSingleRendering(rendering) {
	if (rendering.palette.colourWavePeriod == undefined) {
		if (rendering.map.colourWavePeriod != undefined) {
			rendering.palette.colourWavePeriod = rendering.map.colourWavePeriod;
		} else if (rendering.map.maxColourIndex != undefined) {
			rendering.palette.colourWavePeriod = rendering.map.maxColourIndex;
		} else {
			rendering.palette.colourWavePeriod = defaultConfig.palette.colourWavePeriod;
		}
	}
	for (let primary of ['red', 'green', 'blue']) {
		if (rendering.palette[primary].period == undefined) {
			rendering.palette[primary].period = 1;
		}
	}
	if (rendering.options.calculationFlags == undefined) {
		rendering.options.calculationFlags = JSON.parse(JSON.stringify(defaultConfig.options.calculationFlags));
		if (rendering.options.calculationMethod != undefined) {
			switch (rendering.options.calculationMethod) {
				case 'countPlusDisplacement':
					rendering.options.calculationFlags.displacement = 1;
					break;
				case 'countPlusDisplacementAngle':
					rendering.options.calculationFlags.rotation = 1;
					break;
				case 'countPlusAnglePlusRadius':
					rendering.options.calculationFlags.displacement = 1;
					rendering.options.calculationFlags.rotation = 1;
					break;
				case 'countXORDisplacement':
					rendering.options.calculationFlags.displacementXOR = 1;
					break;
				case 'classic':
					break;
				default:
					throw "migrateSingleRendering: Unhandled configuration";
			}
		}
	}
	if (rendering.options.coefficients == undefined) {
		rendering.options.coefficients = JSON.parse(JSON.stringify(defaultConfig.options.coefficients));
	}
	if (rendering.palette.staggerMask == undefined) {
		rendering.palette.staggerMask = JSON.parse(JSON.stringify(defaultConfig.palette.staggerMask));
	}
	if (rendering.options.recursionDepth == undefined) {
		rendering.options.recursionDepth = 1;
	}
	if (rendering.options.maxRadius == undefined) {
		rendering.options.maxRadius = defaultConfig.options.maxRadius;
	}
	if (rendering.options.countOffset == undefined) {
		rendering.options.countOffset = 0;
	}
	if (rendering.options.staggerBefore == undefined) {
		if (rendering.options.staggerTiming == "before") {
			rendering.options.staggerBefore = 1;
			rendering.options.staggerAfter = 0;
		} else if (rendering.options.staggerTiming == "after") {
			rendering.options.staggerBefore = 0;
			rendering.options.staggerAfter = 1;
		} else if (rendering.options.staggerTiming == "both") {
			rendering.options.staggerBefore = 1;
			rendering.options.staggerAfter = 1;
		}
	}
	delete rendering.options.staggerTiming;
}

// ----------------------------------------------------------------------------
// Original functions (unchanged except where noted)
// ----------------------------------------------------------------------------

// This function takes the count, starting point, and ending point that was
// calculated for a given pixel, and uses that to generate its colour based on
// the selected options.
function createColour(countInfo, config){
	if(countInfo.count >= config.map.accuracy * config.options.recursionDepth){
		return colourBlack;
	}

	var stagger = {
		red : 0,
		green : 0,
		blue : 0
	};

	var count = config.options.countOffset;
	var dz = countInfo.z - countInfo.c;
	var dzi = countInfo.zi - countInfo.ci;
	var ang = rel_ang(countInfo.c, countInfo.ci, countInfo.z, countInfo.zi);
	var radius = Math.pow(dz * dz + dzi * dzi, .5);
	var staggerMask = config.palette.staggerMask;

	// apply the stagger before applying displacement when appropriate
	if(config.options.staggerBefore){
		stagger = {
			red : ((1 << (Math.abs(countInfo.count) % staggerMask.red.length)) & parseInt(staggerMask.red, 2) ? 1 : 0),
			green : ((1 << (Math.abs(countInfo.count) % staggerMask.green.length)) & parseInt(staggerMask.green, 2) ? 1 : 0),
			blue : ((1 << (Math.abs(countInfo.count) % staggerMask.blue.length)) & parseInt(staggerMask.blue, 2) ? 1 : 0)
		}
	}

	// Apply the various uses of the count and displacement

	// the basic iteration count
	if(config.options.calculationFlags.iterations){
		count += countInfo.count * config.options.coefficients.iterations;
	}

	// displacement from starting point to end calculated point
	if(config.options.calculationFlags.displacement){
		if(countInfo.count > 1) count += radius * config.options.coefficients.displacement;
	}

	// end rotation of the calculated point
	if(config.options.calculationFlags.rotation){
		if(countInfo.count > 1) count += (config.map.accuracy / (countInfo.count + 1)) * (.5 + Math.sin(ang) / 2) * config.options.coefficients.rotation;
	}

	// apply the stagger after rotation and displacement, but before exclusive or's
	if(config.options.staggerAfter){
		stagger.red += ((1 << (Math.abs(count) % staggerMask.red.length)) & parseInt(staggerMask.red, 2) ? 1 : 0);
		stagger.green += ((1 << (Math.abs(count) % staggerMask.green.length)) & parseInt(staggerMask.green, 2) ? 1 : 0);
		stagger.blue += ((1 << (Math.abs(count) % staggerMask.blue.length)) & parseInt(staggerMask.blue, 2) ? 1 : 0);
	}

	// xor the x, y coordinates of the displacement and add the result
	if(config.options.calculationFlags.displacementXOR){
		if(countInfo.count > 1){
			count += config.options.coefficients.displacementXOR * ((config.map.accuracy * (countInfo.zi - countInfo.ci)) ^ (config.map.accuracy * (countInfo.z - countInfo.c))) / (config.map.accuracy);
		}else{
			// allow the xor pattern to apply outside of the 4x4 Mandelbrot area
			count += config.options.coefficients.displacementXOR * ((config.map.accuracy * countInfo.zi) ^ (config.map.accuracy * countInfo.z)) / (config.map.accuracy);
		}
	}

	// xor the polar coordinates of the displacement and add the result
	if (config.options.calculationFlags.polarCoordXOR) {
		if (countInfo.count > 1) {
			count += config.options.coefficients.polarCoordXOR * ((config.map.accuracy * ang) ^ (config.map
				.accuracy * radius)) / (config.map.accuracy);
		} else {
			let rad = Math.sqrt(countInfo.z * countInfo.z + countInfo.zi * countInfo.zi);
			let theta = Math.sin(rel_ang(0, 0, countInfo.z, countInfo.zi) * 2 + Math.PI / 2) * Math.PI;
			theta += Math.sin(rad * 4) * 2 / rad;
			count += config.options.coefficients.polarCoordXOR * ((config.map.accuracy * theta) ^ (config.map
				.accuracy * rad)) / (config.map.accuracy);
		}
	}

	// now put it all together with the sine wave functions for the count
	ang = count * 2 * Math.PI / config.palette.colourWavePeriod;
	return {
		red : Math.round(127.5 + 127.5 * 
			Math.sin(
				ang * config.palette.red.period + config.palette.red.offset + config.palette.master.offset +
				(config.palette.red.stagger + config.palette.master.stagger) * stagger.red
			)
		),
		green : Math.round(127.5 + 127.5 * 
			Math.sin(
				ang * config.palette.green.period + config.palette.green.offset + config.palette.master.offset +
				(config.palette.green.stagger + config.palette.master.stagger) * stagger.green 
			)
		),
		blue : Math.round(127.5 + 127.5 * 
			Math.sin(
				ang * config.palette.blue.period + config.palette.blue.offset + config.palette.master.offset +
				(config.palette.blue.stagger + config.palette.master.stagger) * stagger.blue
			)
		),
		alpha : 1
	};
}

// returns the clockwise angle between the upward vertical axis and the line (x1, y1)-(x2, y2)
function rel_ang(x1, y1, x2, y2){
	var hyp, theta, deltax, deltay;
	deltax = x2 - x1;
	deltay = y2 - y1;
	hyp = Math.sqrt(deltax * deltax + deltay * deltay);

	/********* figure out the value for theta *********/
	if(x2 == x1){
		theta = y2 > y1 ? Math.PI : 0;
	}else if(y2 == y1){
		theta = (x2 < x1 ? 3 : 1) * Math.PI / 2
	}else if(x2 > x1){
		theta = Math.PI - Math.acos(deltay / hyp);
	}else{
		theta = 2 * Math.PI - Math.acos(-deltay / hyp);
	}

	return theta;
}

function mandelbrot(c, ci, config, iterations){
	var accuracy = config.map.accuracy;
	var count = 0;
	var z = 0, zi = 0, zsq = 0;
	var zisq = 0;
	if(iterations == undefined) iterations = config.options.recursionDepth;

	// This ugly nesting of the loop inside the switch is for speed, as checking the end condition each time is much slower
	switch(config.options.endCondition){
		case 'multiplication':
			while(count <= accuracy && zsq * zisq < config.options.maxRadius){
				zi = z * zi * 2 + ci;
				z = zsq - zisq + c;
				zsq = z * z;
				zisq = zi * zi;
				count++;
			}
			break;
		case 'subtraction':
			while(count <= accuracy && Math.abs(zsq - zisq) < config.options.maxRadius){ /* lower end value reduces noise */
				zi = z * zi * 2 + ci;
				z = zsq - zisq + c;
				zsq = z * z;
				zisq = zi * zi;
				count++;
			}
			break;
		case 'fluffyCloud':
			while(count <= accuracy && Math.abs(z) + Math.abs(zi) < config.options.maxRadius){
				zi = z * zi * 2 + ci;
				z = zsq - zisq + c;
				zsq = z * z;
				zisq = zi * zi;
				count++;
			}
			break;
		case 'foliage':
			while(count <= accuracy && Math.abs(Math.abs(z) - Math.abs(zi)) < config.options.maxRadius){
				zi = z * zi * 2 + ci;
				z = zsq - zisq + c;
				zsq = z * z;
				zisq = zi * zi;
				count++;
			}
			break;
		default:
			while(count <= accuracy && zsq + zisq < config.options.maxRadius){
				zi = z * zi * 2 + ci;
				z = zsq - zisq + c;
				zsq = z * z;
				zisq = zi * zi;
				count++;
			}
	}

	var rval = {
		count : count,
		z : z,
		zi : zi,
		c : c,
		ci : ci
	};

	if(iterations > 1 && (z != c || zi != ci)){
		let rval2 = mandelbrot(rval.z - rval.c, rval.zi - rval.ci, config, iterations - 1)
		for(let n in rval){
			rval[n] += rval2[n];
		}
	}


	return rval;
}

// ============================================================================
// GPU (WebGL2) acceleration
// ============================================================================

var GPU_MAX_ITER = 4096;       // compile-time cap on iterations per recursion level
var GPU_MAX_RECURSION = 16;    // compile-time cap on recursionDepth
var GPU_MIN_SAFE_WIDTH = 5e-4; // below this map width, fall back to the CPU renderer

var gpuState = {
	checked: false,
	disabled: false,
	canvas: null,
	gl: null,
	quadBuffer: null,
	iterateProgram: null,
	colourProgram: null,
	iterateUniforms: {},
	colourUniforms: {},
	fbo: null,
	texA: null,
	texB: null,
	fboWidth: 0,
	fboHeight: 0,
	cacheKey: null
};

var GPU_DF64_GLSL = `
	// df64: a pair (hi, lo) representing hi + lo, |lo| << |hi|.
	vec2 quickTwoSum(float a, float b) {
		float s = a + b;
		float e = b - (s - a);
		return vec2(s, e);
	}
	vec2 twoSum(float a, float b) {
		float s = a + b;
		float v = s - a;
		float e = (a - (s - v)) + (b - v);
		return vec2(s, e);
	}
	vec2 df64Add(vec2 a, vec2 b) {
		vec2 s = twoSum(a.x, b.x);
		s.y += a.y + b.y;
		return quickTwoSum(s.x, s.y);
	}
	vec2 df64Neg(vec2 a) { return vec2(-a.x, -a.y); }
	vec2 df64Sub(vec2 a, vec2 b) { return df64Add(a, df64Neg(b)); }
	vec2 dfSplit(float a) {
		float c = 4097.0 * a; // 2^12 + 1
		float aHi = c - (c - a);
		float aLo = a - aHi;
		return vec2(aHi, aLo);
	}
	vec2 twoProd(float a, float b) {
		float p = a * b;
		vec2 aS = dfSplit(a);
		vec2 bS = dfSplit(b);
		float e = ((aS.x * bS.x - p) + aS.x * bS.y + aS.y * bS.x) + aS.y * bS.y;
		return vec2(p, e);
	}
	vec2 df64Mul(vec2 a, vec2 b) {
		vec2 p = twoProd(a.x, b.x);
		p.y += a.x * b.y + a.y * b.x;
		return quickTwoSum(p.x, p.y);
	}
	vec2 df64MulF(vec2 a, float b) {
		vec2 p = twoProd(a.x, b);
		p.y += a.y * b;
		return quickTwoSum(p.x, p.y);
	}
	float df64ToFloat(vec2 a) { return a.x + a.y; }
`;

var GPU_VERTEX_SRC = `#version 300 es
	in vec2 a_pos;
	void main() {
		gl_Position = vec4(a_pos, 0.0, 1.0);
	}
`;

var GPU_ITERATE_FRAGMENT_SRC = `#version 300 es
	precision highp float;
	precision highp int;

	uniform vec2 u_cStart, u_ciStart, u_cInc, u_ciInc;
	uniform float u_maxRadius;
	uniform int u_accuracy;
	uniform int u_endCondition; // 0 addition, 1 multiplication, 2 subtraction, 3 fluffyCloud, 4 foliage
	uniform int u_recursionDepth;

	layout(location = 0) out vec4 outA; // count, z, zi, c
	layout(location = 1) out vec4 outB; // ci, -, -, -

	${GPU_DF64_GLSL}

	vec2 axisValue(vec2 start, vec2 inc, float idx) {
		return df64Add(start, df64MulF(inc, idx));
	}

	void iterate(vec2 c, vec2 ci, out float outCount, out vec2 outZ, out vec2 outZi) {
		vec2 z = vec2(0.0), zi = vec2(0.0), zsq = vec2(0.0), zisq = vec2(0.0);
		float count = 0.0;
		for (int i = 0; i < GPU_MAX_ITER_CONST; i++) {
			if (i > u_accuracy) break;
			float zsqf = df64ToFloat(zsq);
			float zisqf = df64ToFloat(zisq);
			bool cont;
			if (u_endCondition == 1) {
				cont = (zsqf * zisqf) < u_maxRadius;
			} else if (u_endCondition == 2) {
				cont = abs(zsqf - zisqf) < u_maxRadius;
			} else if (u_endCondition == 3) {
				float zf = df64ToFloat(z), zif = df64ToFloat(zi);
				cont = (abs(zf) + abs(zif)) < u_maxRadius;
			} else if (u_endCondition == 4) {
				float zf = df64ToFloat(z), zif = df64ToFloat(zi);
				cont = abs(abs(zf) - abs(zif)) < u_maxRadius;
			} else {
				cont = (zsqf + zisqf) < u_maxRadius;
			}
			if (!cont) break;

			vec2 zzi = df64MulF(df64Mul(z, zi), 2.0);
			zi = df64Add(zzi, ci);
			z = df64Add(df64Sub(zsq, zisq), c);
			zsq = df64Mul(z, z);
			zisq = df64Mul(zi, zi);
			count += 1.0;
		}
		outCount = count;
		outZ = z;
		outZi = zi;
	}

	void main() {
		float px = gl_FragCoord.x - 0.5;
		float py = gl_FragCoord.y - 0.5;
		vec2 c0 = axisValue(u_cStart, u_cInc, px);
		vec2 ci0 = axisValue(u_ciStart, u_ciInc, py);

		float totalCount = 0.0;
		vec2 sumZ = vec2(0.0), sumZi = vec2(0.0), sumC = vec2(0.0), sumCi = vec2(0.0);
		vec2 curC = c0, curCi = ci0;

		for (int r = 0; r < GPU_MAX_RECURSION_CONST; r++) {
			if (r >= u_recursionDepth) break;

			float localCount; vec2 localZ, localZi;
			iterate(curC, curCi, localCount, localZ, localZi);

			totalCount += localCount;
			sumZ = df64Add(sumZ, localZ);
			sumZi = df64Add(sumZi, localZi);
			sumC = df64Add(sumC, curC);
			sumCi = df64Add(sumCi, curCi);

			if (r + 1 >= u_recursionDepth) break;

			bool zEqC = abs(df64ToFloat(localZ) - df64ToFloat(curC)) < 1e-30;
			bool ziEqCi = abs(df64ToFloat(localZi) - df64ToFloat(curCi)) < 1e-30;
			if (zEqC && ziEqCi) break;

			curC = df64Sub(localZ, curC);
			curCi = df64Sub(localZi, curCi);
		}

		outA = vec4(totalCount, df64ToFloat(sumZ), df64ToFloat(sumZi), df64ToFloat(sumC));
		outB = vec4(df64ToFloat(sumCi), 0.0, 0.0, 0.0);
	}
`;

var GPU_COLOUR_FRAGMENT_SRC = `#version 300 es
	precision highp float;
	precision highp int;

	uniform sampler2D u_texA;
	uniform sampler2D u_texB;
	uniform float u_accuracyTimesRecursion;
	uniform float u_accuracy;
	uniform float u_countOffset;
	uniform int u_calcIterations, u_calcDisplacement, u_calcRotation, u_calcDisplacementXOR, u_calcPolarXOR;
	uniform float u_coefIterations, u_coefDisplacement, u_coefRotation, u_coefDisplacementXOR, u_coefPolarXOR;
	uniform int u_staggerBefore, u_staggerAfter;
	uniform ivec3 u_staggerMaskVal;
	uniform ivec3 u_staggerMaskLen;
	uniform float u_colourWavePeriod;
	uniform vec3 u_paletteOffset;
	uniform vec3 u_palettePeriod;
	uniform vec3 u_paletteStagger;
	uniform float u_masterOffset, u_masterStagger;

	out vec4 fragColor;

	const float PI = 3.14159265358979;

	float relAng(float x1, float y1, float x2, float y2) {
		float deltax = x2 - x1;
		float deltay = y2 - y1;
		float hyp = sqrt(deltax * deltax + deltay * deltay);
		float theta;
		if (x2 == x1) {
			theta = (y2 > y1) ? PI : 0.0;
		} else if (y2 == y1) {
			theta = (x2 < x1 ? 3.0 : 1.0) * PI / 2.0;
		} else if (x2 > x1) {
			theta = PI - acos(deltay / hyp);
		} else {
			theta = 2.0 * PI - acos(-deltay / hyp);
		}
		return theta;
	}

	int staggerBit(float val, int len, int maskVal) {
		int shiftAmt = int(mod(abs(val), float(len)));
		int bit = (1 << shiftAmt) & maskVal;
		return bit != 0 ? 1 : 0;
	}

	void main() {
		ivec2 p = ivec2(gl_FragCoord.xy);
		vec4 a = texelFetch(u_texA, p, 0);
		vec4 b = texelFetch(u_texB, p, 0);
		float count = a.x, z = a.y, zi = a.z, c = a.w, ci = b.x;

		if (count >= u_accuracyTimesRecursion) {
			fragColor = vec4(0.0, 0.0, 0.0, 1.0);
			return;
		}

		vec3 stagger = vec3(0.0);
		float countVal = u_countOffset;
		float dz = z - c;
		float dzi = zi - ci;
		float ang = relAng(c, ci, z, zi);
		float radius = sqrt(dz * dz + dzi * dzi);

		if (u_staggerBefore == 1) {
			stagger.r = float(staggerBit(count, u_staggerMaskLen.r, u_staggerMaskVal.r));
			stagger.g = float(staggerBit(count, u_staggerMaskLen.g, u_staggerMaskVal.g));
			stagger.b = float(staggerBit(count, u_staggerMaskLen.b, u_staggerMaskVal.b));
		}

		if (u_calcIterations == 1) countVal += count * u_coefIterations;
		if (u_calcDisplacement == 1) { if (count > 1.0) countVal += radius * u_coefDisplacement; }
		if (u_calcRotation == 1) { if (count > 1.0) countVal += (u_accuracy / (count + 1.0)) * (0.5 + sin(ang) / 2.0) * u_coefRotation; }

		if (u_staggerAfter == 1) {
			stagger.r += float(staggerBit(countVal, u_staggerMaskLen.r, u_staggerMaskVal.r));
			stagger.g += float(staggerBit(countVal, u_staggerMaskLen.g, u_staggerMaskVal.g));
			stagger.b += float(staggerBit(countVal, u_staggerMaskLen.b, u_staggerMaskVal.b));
		}

		if (u_calcDisplacementXOR == 1) {
			if (count > 1.0) {
				int xa = int(u_accuracy * dzi);
				int xb = int(u_accuracy * dz);
				countVal += u_coefDisplacementXOR * float(xa ^ xb) / u_accuracy;
			} else {
				int xa = int(u_accuracy * zi);
				int xb = int(u_accuracy * z);
				countVal += u_coefDisplacementXOR * float(xa ^ xb) / u_accuracy;
			}
		}

		if (u_calcPolarXOR == 1) {
			if (count > 1.0) {
				int xa = int(u_accuracy * ang);
				int xb = int(u_accuracy * radius);
				countVal += u_coefPolarXOR * float(xa ^ xb) / u_accuracy;
			} else {
				float rad = sqrt(z * z + zi * zi);
				float theta = sin(relAng(0.0, 0.0, z, zi) * 2.0 + PI / 2.0) * PI;
				theta += sin(rad * 4.0) * 2.0 / rad;
				int xa = int(u_accuracy * theta);
				int xb = int(u_accuracy * rad);
				countVal += u_coefPolarXOR * float(xa ^ xb) / u_accuracy;
			}
		}

		float angFinal = countVal * 2.0 * PI / u_colourWavePeriod;

		float red = 127.5 + 127.5 * sin(angFinal * u_palettePeriod.r + u_paletteOffset.r + u_masterOffset + (u_paletteStagger.r + u_masterStagger) * stagger.r);
		float green = 127.5 + 127.5 * sin(angFinal * u_palettePeriod.g + u_paletteOffset.g + u_masterOffset + (u_paletteStagger.g + u_masterStagger) * stagger.g);
		float blue = 127.5 + 127.5 * sin(angFinal * u_palettePeriod.b + u_paletteOffset.b + u_masterOffset + (u_paletteStagger.b + u_masterStagger) * stagger.b);

		fragColor = vec4(floor(red + 0.5) / 255.0, floor(green + 0.5) / 255.0, floor(blue + 0.5) / 255.0, 1.0);
	}
`;

function gpuCompileShader(gl, type, source) {
	var shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		var log = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error('Shader compile error: ' + log);
	}
	return shader;
}

function gpuLinkProgram(gl, vsSrc, fsSrc) {
	var vs = gpuCompileShader(gl, gl.VERTEX_SHADER, vsSrc);
	var fs = gpuCompileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
	var program = gl.createProgram();
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		var log = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error('Program link error: ' + log);
	}
	return program;
}

function gpuGetUniforms(gl, program, names) {
	var out = {};
	for (var i = 0; i < names.length; i++) {
		out[names[i]] = gl.getUniformLocation(program, names[i]);
	}
	return out;
}

// Splits a JS double into a (hi, lo) float32 pair for df64 uniforms.
function splitDouble(x) {
	var hi = Math.fround(x);
	var lo = Math.fround(x - hi);
	return [hi, lo];
}

function gpuInit() {
	if (gpuState.checked) return !gpuState.disabled;
	gpuState.checked = true;
	try {
		var glCanvas = document.createElement('canvas');
		glCanvas.width = 4;
		glCanvas.height = 4;
		var gl = glCanvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false, alpha: false });
		if (!gl) throw new Error('WebGL2 unavailable');
		if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');

		var iterateSrc = GPU_ITERATE_FRAGMENT_SRC
			.replace('GPU_MAX_ITER_CONST', String(GPU_MAX_ITER))
			.replace('GPU_MAX_RECURSION_CONST', String(GPU_MAX_RECURSION));

		var iterateProgram = gpuLinkProgram(gl, GPU_VERTEX_SRC, iterateSrc);
		var colourProgram = gpuLinkProgram(gl, GPU_VERTEX_SRC, GPU_COLOUR_FRAGMENT_SRC);

		var quadBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

		gpuState.canvas = glCanvas;
		gpuState.gl = gl;
		gpuState.quadBuffer = quadBuffer;
		gpuState.iterateProgram = iterateProgram;
		gpuState.colourProgram = colourProgram;
		gpuState.iterateUniforms = gpuGetUniforms(gl, iterateProgram, [
			'u_cStart', 'u_ciStart', 'u_cInc', 'u_ciInc', 'u_maxRadius', 'u_accuracy', 'u_endCondition', 'u_recursionDepth'
		]);
		gpuState.colourUniforms = gpuGetUniforms(gl, colourProgram, [
			'u_texA', 'u_texB', 'u_accuracyTimesRecursion', 'u_accuracy', 'u_countOffset',
			'u_calcIterations', 'u_calcDisplacement', 'u_calcRotation', 'u_calcDisplacementXOR', 'u_calcPolarXOR',
			'u_coefIterations', 'u_coefDisplacement', 'u_coefRotation', 'u_coefDisplacementXOR', 'u_coefPolarXOR',
			'u_staggerBefore', 'u_staggerAfter', 'u_staggerMaskVal', 'u_staggerMaskLen',
			'u_colourWavePeriod', 'u_paletteOffset', 'u_palettePeriod', 'u_paletteStagger', 'u_masterOffset', 'u_masterStagger'
		]);
		gpuState.disabled = false;
	} catch (e) {
		console.warn('GPU acceleration unavailable, using CPU renderer.', e);
		gpuState.disabled = true;
	}
	return !gpuState.disabled;
}

function gpuEndConditionCode(endCondition) {
	switch (endCondition) {
		case 'multiplication': return 1;
		case 'subtraction': return 2;
		case 'fluffyCloud': return 3;
		case 'foliage': return 4;
		default: return 0;
	}
}

// Decides whether the GPU path can safely & correctly handle this render.
function gpuCanRender(width, height, config) {
	if (!gpuInit()) return false;
	var gl = gpuState.gl;
	var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
	if (width < 1 || height < 1 || width > maxTex || height > maxTex) return false;
	if (Math.abs(config.map.width) < GPU_MIN_SAFE_WIDTH || Math.abs(config.map.height) < GPU_MIN_SAFE_WIDTH) return false;
	if (config.options.recursionDepth > GPU_MAX_RECURSION) return false;
	if (config.map.accuracy > GPU_MAX_ITER) return false;
	return true;
}

function gpuEnsureFBO(width, height) {
	var gl = gpuState.gl;
	if (gpuState.fbo && gpuState.fboWidth === width && gpuState.fboHeight === height) return;

	if (gpuState.fbo) {
		gl.deleteFramebuffer(gpuState.fbo);
		gl.deleteTexture(gpuState.texA);
		gl.deleteTexture(gpuState.texB);
	}

	function makeTex() {
		var tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return tex;
	}

	var texA = makeTex();
	var texB = makeTex();
	var fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texB, 0);
	gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
		throw new Error('Incomplete framebuffer');
	}

	gpuState.fbo = fbo;
	gpuState.texA = texA;
	gpuState.texB = texB;
	gpuState.fboWidth = width;
	gpuState.fboHeight = height;
}

function gpuIterateCacheKey(width, height, config) {
	return [
		width, height, config.map.x, config.map.y, config.map.width, config.map.height,
		config.map.accuracy, config.options.endCondition, config.options.maxRadius, config.options.recursionDepth
	].join('|');
}

function gpuRunIteratePass(width, height, config) {
	var gl = gpuState.gl;
	var key = gpuIterateCacheKey(width, height, config);
	if (gpuState.cacheKey === key && gpuState.fboWidth === width && gpuState.fboHeight === height) return; // reuse cache

	gpuEnsureFBO(width, height);
	gl.bindFramebuffer(gl.FRAMEBUFFER, gpuState.fbo);
	gl.viewport(0, 0, width, height);

	var u = gpuState.iterateUniforms;
	gl.useProgram(gpuState.iterateProgram);

	var cStart = splitDouble(config.map.x - config.map.width / 2);
	var cInc = splitDouble(config.map.width / width);

	// WebGL's framebuffer is bottom-up (row 0 = bottom), while the CPU
	// path/ImageData convention is top-down (row 0 = top). gpuRunColourPass
	// flips the pixel rows on readback to correct for this, but that means
	// the ci value baked into each row during *this* pass needs to be
	// assigned in the opposite order too, or the flip ends up mirroring the
	// y-axis instead of correcting it. So here we start from the ci value
	// the CPU path would use for the *bottom* row and walk upward with a
	// negated increment, so that after the readback flip, row 0 of the
	// final image ends up with the same ci the CPU path would give it.
	var ciIncCPU = config.map.height / height;
	var ciStart = splitDouble((config.map.y - config.map.height / 2) + (height - 1) * ciIncCPU);
	var ciInc = splitDouble(-ciIncCPU);

	gl.uniform2f(u.u_cStart, cStart[0], cStart[1]);
	gl.uniform2f(u.u_ciStart, ciStart[0], ciStart[1]);
	gl.uniform2f(u.u_cInc, cInc[0], cInc[1]);
	gl.uniform2f(u.u_ciInc, ciInc[0], ciInc[1]);
	gl.uniform1f(u.u_maxRadius, config.options.maxRadius);
	gl.uniform1i(u.u_accuracy, config.map.accuracy);
	gl.uniform1i(u.u_endCondition, gpuEndConditionCode(config.options.endCondition));
	gl.uniform1i(u.u_recursionDepth, config.options.recursionDepth);

	gl.bindBuffer(gl.ARRAY_BUFFER, gpuState.quadBuffer);
	var loc = gl.getAttribLocation(gpuState.iterateProgram, 'a_pos');
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
	gl.drawArrays(gl.TRIANGLES, 0, 3);

	gpuState.cacheKey = key;
}

// Uploads already-computed CPU iteration results (the `map` array from
// renderCPU()) into the same GPU textures the iterate pass would have
// produced. This is what lets the (precision-insensitive) colour pass run
// on the GPU even when the (precision-sensitive) iteration had to run on
// the CPU for accuracy reasons - only the iteration itself needs the CPU's
// extra precision; recolouring already-known iteration results doesn't, so
// palette/colour-only redraws can always be fast regardless of zoom depth.
function gpuUploadCPUMap(width, height, config, cpuMap) {
	if (!gpuInit()) return false;
	var gl = gpuState.gl;

	try {
		gpuEnsureFBO(width, height);

		var texA = new Float32Array(width * height * 4);
		var texB = new Float32Array(width * height * 4);

		// texA/texB are sampled by the colour pass via
		// texelFetch(tex, ivec2(gl_FragCoord.xy)) - the same bottom-up row
		// order the iterate pass's fragment shader writes them in. The CPU
		// `map` array is top-down (map[x][y], y=0 is the top row), so
		// texture row R corresponds to CPU row (height-1-R) - the same flip
		// gpuRunIteratePass's ci setup uses, kept consistent here.
		for (var yTex = 0; yTex < height; yTex++) {
			var yCpu = height - 1 - yTex;
			var rowOffset = yTex * width * 4;
			for (var x = 0; x < width; x++) {
				var p = cpuMap[x][yCpu];
				var idx = rowOffset + x * 4;
				texA[idx] = p.count;
				texA[idx + 1] = p.z;
				texA[idx + 2] = p.zi;
				texA[idx + 3] = p.c;
				texB[idx] = p.ci;
			}
		}

		gl.bindTexture(gl.TEXTURE_2D, gpuState.texA);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, texA);
		gl.bindTexture(gl.TEXTURE_2D, gpuState.texB);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, texB);
	} catch (e) {
		console.warn('Uploading CPU iteration results to the GPU for fast recolouring failed.', e);
		gpuState.disabled = true;
		return false;
	}

	gpuState.cacheKey = gpuIterateCacheKey(width, height, config);
	gpuState.fboWidth = width;
	gpuState.fboHeight = height;
	return true;
}

function gpuParseStaggerMask(mask) {
	return { value: parseInt(mask, 2) || 0, length: mask.length || 1 };
}

function gpuRunColourPass(width, height, config) {
	var gl = gpuState.gl;
	var glCanvas = gpuState.canvas;
	if (glCanvas.width !== width || glCanvas.height !== height) {
		glCanvas.width = width;
		glCanvas.height = height;
	}

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, width, height);
	gl.useProgram(gpuState.colourProgram);

	var u = gpuState.colourUniforms;
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, gpuState.texA);
	gl.uniform1i(u.u_texA, 0);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, gpuState.texB);
	gl.uniform1i(u.u_texB, 1);

	gl.uniform1f(u.u_accuracyTimesRecursion, config.map.accuracy * config.options.recursionDepth);
	gl.uniform1f(u.u_accuracy, config.map.accuracy);
	gl.uniform1f(u.u_countOffset, config.options.countOffset || 0);

	var flags = config.options.calculationFlags;
	gl.uniform1i(u.u_calcIterations, flags.iterations ? 1 : 0);
	gl.uniform1i(u.u_calcDisplacement, flags.displacement ? 1 : 0);
	gl.uniform1i(u.u_calcRotation, flags.rotation ? 1 : 0);
	gl.uniform1i(u.u_calcDisplacementXOR, flags.displacementXOR ? 1 : 0);
	gl.uniform1i(u.u_calcPolarXOR, flags.polarCoordXOR ? 1 : 0);

	var coef = config.options.coefficients;
	gl.uniform1f(u.u_coefIterations, coef.iterations);
	gl.uniform1f(u.u_coefDisplacement, coef.displacement);
	gl.uniform1f(u.u_coefRotation, coef.rotation);
	gl.uniform1f(u.u_coefDisplacementXOR, coef.displacementXOR);
	gl.uniform1f(u.u_coefPolarXOR, coef.polarCoordXOR);

	gl.uniform1i(u.u_staggerBefore, 1 * config.options.staggerBefore ? 1 : 0);
	gl.uniform1i(u.u_staggerAfter, 1 * config.options.staggerAfter ? 1 : 0);

	var maskR = gpuParseStaggerMask(config.palette.staggerMask.red);
	var maskG = gpuParseStaggerMask(config.palette.staggerMask.green);
	var maskB = gpuParseStaggerMask(config.palette.staggerMask.blue);
	gl.uniform3i(u.u_staggerMaskVal, maskR.value, maskG.value, maskB.value);
	gl.uniform3i(u.u_staggerMaskLen, maskR.length, maskG.length, maskB.length);

	gl.uniform1f(u.u_colourWavePeriod, config.palette.colourWavePeriod);
	gl.uniform3f(u.u_paletteOffset, config.palette.red.offset, config.palette.green.offset, config.palette.blue.offset);
	gl.uniform3f(u.u_palettePeriod, config.palette.red.period, config.palette.green.period, config.palette.blue.period);
	gl.uniform3f(u.u_paletteStagger, config.palette.red.stagger, config.palette.green.stagger, config.palette.blue.stagger);
	gl.uniform1f(u.u_masterOffset, config.palette.master.offset);
	gl.uniform1f(u.u_masterStagger, config.palette.master.stagger);

	gl.bindBuffer(gl.ARRAY_BUFFER, gpuState.quadBuffer);
	var loc = gl.getAttribLocation(gpuState.colourProgram, 'a_pos');
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
	gl.drawArrays(gl.TRIANGLES, 0, 3);

	var raw = new Uint8Array(width * height * 4);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);

	// WebGL's framebuffer origin is bottom-left; ImageData's is top-left.
	var out = new Uint8ClampedArray(width * height * 4);
	var rowBytes = width * 4;
	for (var y = 0; y < height; y++) {
		var srcOffset = (height - 1 - y) * rowBytes;
		out.set(raw.subarray(srcOffset, srcOffset + rowBytes), y * rowBytes);
	}
	return out;
}

// Full render (pass 1 + pass 2). Returns a Uint8ClampedArray of RGBA bytes,
// or null if the GPU path isn't usable for this render (caller should fall
// back to the CPU implementation).
function gpuRender(width, height, config) {
	if (!gpuCanRender(width, height, config)) return null;
	try {
		gpuRunIteratePass(width, height, config);
		return gpuRunColourPass(width, height, config);
	} catch (e) {
		console.warn('GPU render failed, falling back to CPU.', e);
		gpuState.disabled = true;
		return null;
	}
}

// Recolour only (pass 2), used by redraw() when only palette/colour options
// changed - no re-iteration needed. Reuses cached GPU iteration data if it's
// still valid for the current map/options; otherwise, if the last iteration
// ran on the CPU (deep zoom), uploads that CPU-computed data to the GPU
// first so the colour pass can still run there. Returns null if neither is
// usable (caller should fall back to a full render or a CPU colour pass).
function gpuRecolour(width, height, config, cpuMap) {
	if (gpuState.disabled || !gpuState.gl) return null;

	var cacheValid = gpuState.cacheKey === gpuIterateCacheKey(width, height, config)
		&& gpuState.fboWidth === width && gpuState.fboHeight === height;

	if (!cacheValid) {
		if (!cpuMap) return null;
		if (!gpuUploadCPUMap(width, height, config, cpuMap)) return null;
	}

	try {
		return gpuRunColourPass(width, height, config);
	} catch (e) {
		console.warn('GPU recolour failed, falling back to CPU.', e);
		gpuState.disabled = true;
		return null;
	}
}

// used for rendering images outside of the view area
function staticRender(targetCanvas, width, height, config) {
	var img = new ImageData(width, height);
	var gpuPixels = gpuRender(width, height, config);
	if (gpuPixels) {
		img.data.set(gpuPixels);
	} else {
		staticRenderCPU(img, width, height, config);
	}
	targetCanvas.getContext('2d').putImageData(img, 0, 0);
	return img.data;
}

// original CPU implementation, used as a fallback when the GPU path is
// unavailable or unsafe for the requested map width (see gpu_module.js)
function staticRenderCPU(img, width, height, config) {
	var x, y, colour;
	var c,
		cStart = config.map.x - config.map.width / 2;
	var ci = config.map.y - config.map.height / 2;
	var cInc = config.map.width / width;
	var ciInc = config.map.height / height;
	var idx = 0;
	for (y = 0; y < height; y++) {
		c = cStart;
		for (x = 0; x < width; x++) {
			colour = createColour(mandelbrot(c, ci, config), config);
			img.data[idx++] = colour.red;
			img.data[idx++] = colour.green;
			img.data[idx++] = colour.blue;
			img.data[idx++] = 255;
			c += cInc;
		}
		ci += ciInc;
	}
}

// tracks how the currently-displayed frame's iteration data was produced
// (GPU shader vs. CPU `mandelbrot()` calls), so redraw() knows where to
// find cached iteration results to recolour from.
var lastRenderUsedGPU = false;

function render() {
	activeRendering = 1;

	if (gpuCanRender(canvas.width, canvas.height, config)) {
		try {
			gpuRunIteratePass(canvas.width, canvas.height, config);
			lastRenderUsedGPU = true;
			map = null; // not needed on the GPU path; frees the old CPU cache
			redraw();
			activeRendering = 0;
			return;
		} catch (e) {
			console.warn('GPU render failed, falling back to CPU.', e);
			gpuState.disabled = true;
			// fall through to the CPU path below
		}
	}
	lastRenderUsedGPU = false;
	renderCPU(); // async (chunked) - clears activeRendering itself when done
}

// original CPU implementation, used as a fallback when the GPU path is
// unavailable or unsafe for the requested map width (see gpu_module.js).
//
// Chunked with setTimeout(...,0), the same way bgRenderCPU() already
// chunks background/download renders. Without this, a deep enough zoom
// (or a large enough canvas) blocks the main thread long enough to trigger
// the browser's "page unresponsive" warning - most noticeable right after
// loading a deep zoom from a saved URL, since it runs immediately on page
// load before you've had a chance to do anything.
function renderCPU() {
	var width = canvas.width, height = canvas.height;
	var cStart = config.map.x - config.map.width / 2;
	var ciStart = config.map.y - config.map.height / 2;
	var cInc = config.map.width / width;
	var ciInc = config.map.height / height;
	var area = width * height;

	map = [];
	for (var x = 0; x < width; x++) map[x] = [];

	var idx = 0, chunkSize = 20000;
	var progress = createProgressIndicator('Rendering', '✕');

	var renderSegment = function() {
		var n, x, y, c, ci;
		for (n = idx; n < area && n < idx + chunkSize; n++) {
			x = (n / height) | 0;
			y = n % height;
			c = cStart + x * cInc;
			ci = ciStart + y * ciInc;
			map[x][y] = mandelbrot(c, ci, config);
		}
		idx = n;
		if (progress.cancelled) {
			progress.remove();
			activeRendering = 0;
		} else if (idx < area) {
			progress.update(idx / area);
			setTimeout(renderSegment, 0);
		} else {
			progress.remove();
			redraw();
			activeRendering = 0;
		}
	};
	renderSegment();
}

// ---- throttled redraw for continuous controls ----
// The palette offset/stagger sliders and the value-adjuster widgets all
// call back continuously while the user drags, the way a native range
// slider's `input` event does. That's fine on the GPU path, where a full
// colour pass is cheap, but when the CPU is doing it (no WebGL2, or a deep
// zoom where the precision fallback kicked in) a full JS loop over every
// pixel per frame turns dragging into a slideshow. This caps repaints on
// the CPU path; the trailing call guarantees the final value is painted.
var REDRAW_CPU_INTERVAL = 100; // ms; ~10fps while dragging on the CPU path
var _lastRedrawTime = 0;
var _redrawPending = false;

function scheduleRedraw() {
	if (!gpuState.disabled) {
		redraw(); // GPU path: no reason to delay
		return;
	}
	var now = performance.now();
	var elapsed = now - _lastRedrawTime;
	if (elapsed >= REDRAW_CPU_INTERVAL) {
		_lastRedrawTime = now;
		redraw();
	} else if (!_redrawPending) {
		_redrawPending = true;
		setTimeout(function () {
			_redrawPending = false;
			_lastRedrawTime = performance.now();
			redraw();
		}, REDRAW_CPU_INTERVAL - elapsed);
	}
}

function redraw() {
	// Try the GPU colour pass first, regardless of whether the iteration
	// itself ran on the GPU or the CPU - only the iteration needs the
	// CPU's extra precision at deep zoom; recolouring from already-known
	// iteration results doesn't, so this keeps palette/colour-only changes
	// fast at any zoom depth. If the iteration ran on the CPU and there's
	// no matching GPU cache yet, this uploads the CPU results first.
	var gpuPixels = gpuRecolour(canvas.width, canvas.height, config, lastRenderUsedGPU ? null : map);
	if (gpuPixels) {
		var img = new ImageData(canvas.width, canvas.height);
		img.data.set(gpuPixels);
		context.putImageData(img, 0, 0);
		return;
	}

	if (lastRenderUsedGPU) {
		// GPU cache miss (e.g. resized since the last full render) - do a
		// full render instead of a partial recolour.
		render();
		return;
	}

	// Reached only if the GPU is entirely unavailable, or the upload/colour
	// pass itself failed - fall back to the original CPU colour loop.
	var x, y, colour;
	var img = new ImageData(canvas.width, canvas.height);
	var idx = 0;
	for (y = 0; y < canvas.height; y++) {
		for (x = 0; x < canvas.width; x++) {
			colour = createColour(map[x][y], config)
			img.data[idx++] = colour.red;
			img.data[idx++] = colour.green;
			img.data[idx++] = colour.blue;
			img.data[idx++] = 255;
		}
	}
	context.putImageData(img, 0, 0);
}

function resetMandelbrot() {
	var map = JSON.parse(JSON.stringify(defaultConfig.map));

	config.map.x = map.x;
	config.map.y = map.y;
	config.map.width = map.width;
	correctHeightRatio(config);
	config.map.accuracy = map.accuracy;
	config.options.countOffset = defaultConfig.options.countOffset;

	document.getElementById('xOffset').value = config.map.x;
	document.getElementById('yOffset').value = config.map.y;
	document.getElementById('width').value = config.map.width;
	document.getElementById('accuracy').value = config.map.accuracy;
	setAdjusterValue('countOffset', config.options.countOffset);


	render();
}

function resetRenderOptions() {
	var palette = JSON.parse(JSON.stringify(defaultConfig.palette));
	config.palette.colourWavePeriod = palette.colourWavePeriod;
	setAdjusterValue('numcolours', config.palette.colourWavePeriod);

	render();
}

function updateFields() {
	document.getElementById('xOffset').value = config.map.x;
	document.getElementById('yOffset').value = config.map.y;
	document.getElementById('width').value = config.map.width;
	document.getElementById('accuracy').value = config.map.accuracy;
	document.getElementById('maxRadius').value = config.options.maxRadius || 4;
	document.getElementById('recursionDepth').value = config.options.recursionDepth || 1;

	setAdjusterValue('numcolours', config.palette.colourWavePeriod);
	setAdjusterValue('countOffset', config.options.countOffset || 0);

	// Set end condition radio by value
	var endValue = config.options.endCondition || 'addition';
	var radios = document.querySelectorAll('input[name="endCondition"]');
	for (var r of radios) {
		r.checked = (r.value === endValue);
	}

	document.getElementById('calculationIterations').checked = config.options.calculationFlags.iterations != 0;
	document.getElementById('calculationDisplacement').checked = config.options.calculationFlags.displacement != 0;
	document.getElementById('calculationRotation').checked = config.options.calculationFlags.rotation != 0;
	document.getElementById('calculationXORDisplacement').checked = config.options.calculationFlags.displacementXOR != 0;
	document.getElementById('calculationXORPolar').checked = config.options.calculationFlags.polarCoordXOR != 0;

	document.getElementById('iterationCoefficient').value = config.options.coefficients.iterations;
	document.getElementById('displacementCoefficient').value = config.options.coefficients.displacement;
	document.getElementById('rotationCoefficient').value = config.options.coefficients.rotation;
	document.getElementById('displacementXORCoefficient').value = config.options.coefficients.displacementXOR;
	document.getElementById('polarCoordXORCoefficient').value = config.options.coefficients.polarCoordXOR;

	document.getElementById('staggerBefore').checked = config.options.staggerBefore;
	document.getElementById('staggerAfter').checked = config.options.staggerAfter;

	drawPaletteGraph();
};


function correctHeightRatio(config) {
	config.map.height = config.map.width * canvas.height / canvas.width;
}

// ============================================================================
// Modified functions for IndexedDB
// ============================================================================

// Global DB instance (promise that resolves to db)
var dbPromise = null;

// Store the array of saved renderings from DB (for UI)
var savedRenderingsCache = [];

// Render thumbnails and update DB
function renderThumbnailForRecord(record, db) {
	return new Promise((resolve, reject) => {
		var cnvs = document.createElement('canvas');
		cnvs.width = thumbnailSize;
		cnvs.height = thumbnailSize;
		var thumbConfig = JSON.parse(JSON.stringify(record.config));
		thumbConfig.map.width = thumbConfig.map.height * cnvs.width / cnvs.height;
		staticRender(cnvs, cnvs.width, cnvs.height, thumbConfig);
		cnvs.toBlob(function(blob) {
			if (!blob) {
				reject(new Error('Failed to create blob'));
				return;
			}
			// Update DB with blob and dimensions
			updateRenderingInDB(db, record.id, {
				thumbnailBlob: blob,
				thumbnailWidth: thumbnailSize,
				thumbnailHeight: thumbnailSize
			}).then(function() {
				record.thumbnailBlob = blob;
				record.thumbnailWidth = thumbnailSize;
				record.thumbnailHeight = thumbnailSize;
				resolve(record);
			}).catch(reject);
		}, 'image/png');
	});
}

// Build a load button from a record (with optional existing thumbnail)
function buildLoadButton(record, options) {
	var button;
	if (options == undefined) options = {};
	if (options.button == undefined) {
		button = document.createElement('div');
		button.className = 'thumb';
	} else {
		button = options.button;
	}
	button.dataset.id = record.id;

	// Decide if we can use stored thumbnail
	var useStored = record.thumbnailBlob &&
		record.thumbnailWidth === thumbnailSize &&
		record.thumbnailHeight === thumbnailSize;

	if (useStored) {
		var img = document.createElement('img');
		var url = URL.createObjectURL(record.thumbnailBlob);
		img.src = url;
		img.onload = function() { URL.revokeObjectURL(url); };
		button.appendChild(img);
	} else {
		// No stored thumbnail or invalid size.
		// If noStore is true, render immediately without DB.
		if (options.noStore) {
			// Render thumbnail synchronously and put it in the button
			var cnvs = document.createElement('canvas');
			cnvs.width = thumbnailSize;
			cnvs.height = thumbnailSize;
			var thumbConfig = JSON.parse(JSON.stringify(record.config));
			thumbConfig.map.width = thumbConfig.map.height * cnvs.width / cnvs.height;
			staticRender(cnvs, cnvs.width, cnvs.height, thumbConfig);
			var img = document.createElement('img');
			img.src = cnvs.toDataURL('image/png');
			button.appendChild(img);
		} else {
			// For saved renderings (noStore false), show placeholder and render async, then update DB
			var placeholder = document.createElement('div');
			placeholder.style.width = thumbnailSize + 'px';
			placeholder.style.height = thumbnailSize + 'px';
			placeholder.style.background = '#ccc';
			placeholder.style.display = 'flex';
			placeholder.style.alignItems = 'center';
			placeholder.style.justifyContent = 'center';
			placeholder.textContent = '…';
			button.appendChild(placeholder);
			// Render thumbnail asynchronously and update DB
			if (dbPromise) {
				dbPromise.then(function(db) {
					renderThumbnailForRecord(record, db).then(function(updatedRecord) {
						// Replace placeholder with image
						button.innerHTML = '';
						var img = document.createElement('img');
						var url = URL.createObjectURL(updatedRecord.thumbnailBlob);
						img.src = url;
						img.onload = function() { URL.revokeObjectURL(url); };
						button.appendChild(img);
					}).catch(function(e) {
						console.warn('Thumbnail render failed for record', record.id, e);
					});
				});
			}
		}
	}

	button.onclick = function() {
		config = JSON.parse(JSON.stringify(record.config));
		if (config.options == undefined) { config.options = {}; }
		correctHeightRatio(config);
		refreshAll();
	}

	if (!options.noDelete) {
		var del = document.createElement('button');
		del.className = 'delete-icon';
		del.textContent = '✕';

		del.onclick = function(e) {
			e.stopPropagation();
			var content = document.createElement('div');
			content.innerHTML = "Delete this saved rendering?";
			content.style.textAlign = "center";
			popup(content, [
				{ label: "Yes", action: function() {
					deleteSavedLocation(record.id);
					button.remove();
					closePopup();
				}},
				{ label: "No", action: closePopup }
			]);
		};
		button.appendChild(del);
	}
	return button;
}

// New saveLocation using IndexedDB
function saveLocation() {
	if (!dbPromise) {
		alert('IndexedDB not ready');
		return;
	}
	var recordConfig = JSON.parse(JSON.stringify(config));
	// Generate thumbnail first? We'll store config first, then add thumbnail.
	dbPromise.then(function(db) {
		// Add record without thumbnail
		return addRenderingToDB(db, recordConfig, null, 0, 0).then(function(id) {
			// Now we have an id, render thumbnail and update
			var record = { id: id, config: recordConfig, thumbnailBlob: null, thumbnailWidth: 0, thumbnailHeight: 0 };
			return renderThumbnailForRecord(record, db).then(function(updatedRecord) {
				// Append button to UI
				var container = document.getElementById('savedRenderings');
				var btn = buildLoadButton(updatedRecord);
				container.appendChild(btn);
				container.scrollLeft = container.scrollWidth;
				// Update cache
				savedRenderingsCache.push(updatedRecord);
				return updatedRecord;
			});
		});
	}).catch(function(e) {
		console.error('Save failed', e);
		alert('Failed to save rendering.');
	});
}

// New deleteSavedLocation using IndexedDB
function deleteSavedLocation(id) {
	if (!dbPromise) return;
	dbPromise.then(function(db) {
		return deleteRenderingFromDB(db, id);
	}).then(function() {
		// Remove from cache
		var idx = savedRenderingsCache.findIndex(r => r.id === id);
		if (idx !== -1) savedRenderingsCache.splice(idx, 1);
	}).catch(function(e) {
		console.error('Delete failed', e);
	});
}

// Render saved locations from IndexedDB, fallback to localStorage if empty
async function renderSavedLocations() {
	try {
		dbPromise = openDB();
		var db = await dbPromise;
		var renderings = await getAllRenderingsFromDB(db);

		if (renderings.length === 0) {
			// Try localStorage
			var lsData = localStorage.getItem('renderings');
			if (lsData) {
				var lsRenderings = JSON.parse(lsData);
				if (Array.isArray(lsRenderings) && lsRenderings.length > 0) {
					// Migrate each config
					lsRenderings.forEach(migrateSingleRendering);
					// Import into DB (without thumbnails)
					await migrateFromLocalStorage(db, lsRenderings);
					// Re-fetch
					renderings = await getAllRenderingsFromDB(db);
				}
			}
		}

		// Now render buttons
		var target = document.getElementById('savedRenderings');
		target.innerHTML = ''; // clear
		savedRenderingsCache = renderings;

		// Render each thumbnail (async, but we'll append buttons with placeholders that will update)
		for (var rec of renderings) {
			var btn = buildLoadButton(rec);
			target.appendChild(btn);
		}
	} catch (e) {
		console.warn('Error loading saved renderings from IndexedDB', e);
		// Fallback: try localStorage directly
		var lsData = localStorage.getItem('renderings');
		if (lsData) {
			try {
				var lsRenderings = JSON.parse(lsData);
				if (Array.isArray(lsRenderings)) {
					lsRenderings.forEach(migrateSingleRendering);
					var target = document.getElementById('savedRenderings');
					target.innerHTML = '';
					for (var i = 0; i < lsRenderings.length; i++) {
						var rec = { id: i, config: lsRenderings[i] };
						var btn = buildLoadButton(rec, { noDelete: true }); // no delete for localStorage fallback
						target.appendChild(btn);
					}
				}
			} catch (e2) {}
		}
	}
}

// Demo samples remain unchanged (they load from JSON, no need to store)
async function renderSampleLocations() {
	try {
		let file = await fetch('samples.json?' + Math.floor(Math.random() * 1000000));
		let samples = JSON.parse(await file.text());
		for (let n in samples) {
			// Demo record: no id, no store, no delete
			var rec = { id: null, config: samples[n] };
			var btn = buildLoadButton(rec, { noDelete: true, noStore: true });
			document.getElementById('demos').appendChild(btn);
		}
	} catch (e) { console.warn('Samples not loaded', e); }
}

// ----------------------------------------------------------------------------
// Remaining UI functions (unchanged except popup etc.)
// ----------------------------------------------------------------------------

function showWelcomeWindow() {
	var content = document.createElement('div');
	content.innerHTML = `
		<h2>Mandelbrot Explorer</h2>
		<p>Explore the Mandelbrot set and play with colours.</p>
		<ul>
			<li><strong>Mousewheel</strong> zooms in/out</li>
			<li><strong>Left click</strong> centers on that point</li>
			<li><strong>Drag</strong> to move the view</li>
		</ul>
		<p style="margin-top:0.5rem;font-size:0.8rem;color:rgba(0,0,0,0.4);">Adjust parameters in the sidebar.</p>
	`;
	popup(content, [
		{ label: "Close", action: closePopup }
	]);
}

function URLPopup() {
	var content = document.createElement('div');
	var configText = serializeConfig(config);
	var url = window.location.protocol + '//' + window.location.hostname + window.location.pathname + '?config=' + configText;
	content.innerHTML = `
		<h2>Share this rendering</h2>
		<p style="font-size:0.8rem;color:rgba(0,0,0,0.5);">Copy the URL below to share this exact view.</p>
		<textarea readonly>${url}</textarea>
	`;
	popup(content, [{ label: "Close", action: closePopup }]);
}

// Creates a lightweight progress bar overlay for chunked CPU renders (see
// renderCPU()/bgRenderCPU()). Returns { update(fraction), remove(),
// cancelled } - `cancelled` flips to true if the optional cancel button
// (shown only when a cancelLabel is passed) is clicked.
function createProgressIndicator(label, cancelLabel) {
	var state = { cancelled: false };
	var wrap = document.createElement('div');
	wrap.className = 'progress-wrap';
	wrap.innerHTML = `
		<span style="font-size:0.7rem;font-weight:500;">${label}</span>
		<div class="bar"><div class="fill"></div></div>
		<span class="pct" style="font-size:0.7rem;font-weight:500;min-width:2.4rem;">0%</span>
	` + (cancelLabel ? '<button class="cancel-btn">' + cancelLabel + '</button>' : '');
	document.body.appendChild(wrap);
	// scoped to `wrap` (not global IDs) so two progress bars can coexist,
	// e.g. a background download render running alongside a main-canvas one
	var fill = wrap.querySelector('.fill');
	var pct = wrap.querySelector('.pct');
	if (cancelLabel) {
		wrap.querySelector('.cancel-btn').onclick = function() { state.cancelled = true; };
	}
	state.update = function(fraction) {
		var pc = Math.round(100 * fraction);
		fill.style.width = pc + '%';
		pct.textContent = pc + '%';
	};
	state.remove = function() { wrap.remove(); };
	return state;
}

// render the image in the background
// used for downloading, to avoid page not responding errors
function bgRender(targetCanvas, width, height, config, onComplete) {
	var ctx = targetCanvas.getContext('2d');

	// The GPU renders the whole image in one shot, fast enough that a
	// progress bar/cancel button isn't meaningful - just render and finish.
	var gpuPixels = gpuRender(width, height, config);
	if (gpuPixels) {
		var img = new ImageData(width, height);
		img.data.set(gpuPixels);
		ctx.putImageData(img, 0, 0);
		onComplete();
		return;
	}

	bgRenderCPU(targetCanvas, width, height, config, onComplete);
}

// original CPU implementation, used as a fallback when the GPU path is
// unavailable or unsafe for the requested map width (see gpu_module.js).
// Chunked with a progress bar/cancel button since CPU deep-zoom renders of
// large images can take a while.
function bgRenderCPU(targetCanvas, width, height, config, onComplete) {
	var x, y, c, ci, colour, ctx = targetCanvas.getContext('2d');
	var area = targetCanvas.width * targetCanvas.height;
	var idx = 0, chunkSize = 2000;
	var progress = createProgressIndicator('Rendering', '✕');

	var img = new ImageData(width, height);
	var renderSegment = function() {
		var n;
		for (n = idx; n < area && n < idx + chunkSize; n++) {
			x = n % targetCanvas.width;
			y = Math.floor(n / targetCanvas.width);
			c = config.map.x - config.map.width / 2 + x * config.map.width / width;
			ci = config.map.y - config.map.height / 2 + y * config.map.height / height;
			colour = createColour(mandelbrot(c, ci, config), config);
			img.data[(n << 2) + 0] = colour.red;
			img.data[(n << 2) + 1] = colour.green;
			img.data[(n << 2) + 2] = colour.blue;
			img.data[(n << 2) + 3] = 255;
		}
		idx = n;
		if (progress.cancelled) {
			progress.remove();
		} else if (idx < area) {
			progress.update(idx / area);
			setTimeout(renderSegment, 1);
		} else {
			ctx.putImageData(img, 0, 0);
			progress.remove();
			onComplete();
		}
	};
	renderSegment();
}

function exportImage() {
	var content = document.createElement('div');
	content.className = 'download-form';
	content.innerHTML = `
		<h2>Download Image</h2>
		<div class="preview-wrapper" id="previewWrapper"></div>
		<div class="field-row"><label>Width</label><input type="number" id="dlWidth" step="1" min="1" value="${canvas.width}" /></div>
		<div class="field-row"><label>Height</label><input type="number" id="dlHeight" step="1" min="1" value="${canvas.height}" /></div>
	`;
	var dlWidth = content.querySelector('#dlWidth');
	var dlHeight = content.querySelector('#dlHeight');

	var updatePreview = function() {
		var w = parseInt(dlWidth.value) || canvas.width;
		var h = parseInt(dlHeight.value) || canvas.height;
		var maxPx = 256;
		var pw, ph;
		if (w > h) { pw = Math.min(w, maxPx);
			ph = Math.round(h * pw / w); } else { ph = Math.min(h, maxPx);
			pw = Math.round(w * ph / h); }
		var c = document.createElement('canvas');
		c.width = pw;
		c.height = ph;
		var cfg = JSON.parse(JSON.stringify(config));
		cfg.map.width = cfg.map.height * pw / ph;
		staticRender(c, pw, ph, cfg);
		var wrap = content.querySelector('#previewWrapper');
		wrap.innerHTML = '';
		wrap.appendChild(c);
	};
	dlWidth.onchange = dlHeight.onchange = updatePreview;
	updatePreview();

	popup(content, [
		{ label: "Cancel", action: closePopup },
		{ label: "Download", action: function() {
				var w = parseInt(dlWidth.value) || canvas.width;
				var h = parseInt(dlHeight.value) || canvas.height;
				var cfg = JSON.parse(JSON.stringify(config));
				cfg.map.width = cfg.map.height * w / h;
				var c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				closePopup();
				bgRender(c, w, h, cfg, function() {
					var link = document.createElement('a');
					link.download = 'mandelbrot.png';
					link.href = c.toDataURL('image/png');
					link.click();
				});
			} }
	]);
}

function editBitmask() {
	var content = document.createElement('div');
	content.innerHTML = `
		<h2>Stagger Bitmask</h2>
		<p style="font-size:0.8rem;color:rgba(0,0,0,0.5);">1 = staggered, 0 = not. Pattern repeats.</p>
		<div class="field-row"><label>Red</label><input type="text" id="bmRed" value="${config.palette.staggerMask.red}" /></div>
		<div class="field-row"><label>Green</label><input type="text" id="bmGreen" value="${config.palette.staggerMask.green}" /></div>
		<div class="field-row"><label>Blue</label><input type="text" id="bmBlue" value="${config.palette.staggerMask.blue}" /></div>
	`;
	var bmRed = content.querySelector('#bmRed');
	var bmGreen = content.querySelector('#bmGreen');
	var bmBlue = content.querySelector('#bmBlue');
	for (var inp of [bmRed, bmGreen, bmBlue]) {
		inp.addEventListener('input', function() { this.value = this.value.replace(/[^01]/g, ''); });
	}
	popup(content, [
		{ label: "Cancel", action: closePopup },
		{ label: "Apply", action: function() {
			config.palette.staggerMask.red = bmRed.value || '0';
			config.palette.staggerMask.green = bmGreen.value || '0';
			config.palette.staggerMask.blue = bmBlue.value || '0';
			redraw();
			closePopup();
		} }
	]);
}

function showPaletteInfo() {
	var content = document.createElement('div');
	content.innerHTML = `
		<h2>Palette Guide</h2>
		<p>Colours are generated from the iteration count using sine waves.</p>
		<code style="white-space:pre-wrap;">c(n) = 127.5 + 127.5 × sin(period × 2πn / wavePeriod + offset + stagger)</code>
		<ul>
			<li><strong>Wave Period</strong> – smoothness of colour transitions</li>
			<li><strong>Offset</strong> – shifts the hue</li>
			<li><strong>Stagger</strong> – alternates the colour every N counts</li>
			<li><strong>Period</strong> – frequency multiplier per primary</li>
		</ul>
	`;
	popup(content, [{ label: "Close", action: closePopup }]);
}

function popup(content, buttons) {
	var overlay = document.getElementById('popupOverlay');
	var box = document.getElementById('popupBox');
	var contentArea = document.getElementById('popupContent');
	var actionArea = document.getElementById('popupActions');
	contentArea.innerHTML = '';
	actionArea.innerHTML = '';
	contentArea.appendChild(content);
	for (var b of buttons) {
		var btn = document.createElement('button');
		btn.className = 'btn' + (b.primary ? ' btn-primary' : '');
		btn.textContent = b.label;
		btn.onclick = b.action;
		actionArea.appendChild(btn);
	}
	overlay.classList.add('open');
	return overlay;
}

function closePopup() {
	document.getElementById('popupOverlay').classList.remove('open');
}

function emptyNode(node) { while (node.firstChild) node.removeChild(node.lastChild); }

function loadDefaults() {
	config = JSON.parse(JSON.stringify(defaultConfig));
	correctHeightRatio(config);
	refreshAll();
}

function refreshAll() {
	initPaletteAdjusters();
	updateFields();
	render();
}

// ---- UI initialisation ----
function initMouseWheel() {
	canvas.onwheel = (function() {
		var zoomChange = 0;
		return function(e) {
			e.preventDefault();
			e.stopPropagation();
			zoomChange += e.deltaY > 0 ? 1 : -1;
			var myDelta = zoomChange;
			setTimeout(function() {
				if (myDelta == zoomChange) {
					var oldWidth = config.map.width;
					var oldHeight = config.map.height;
					var multiple = (1 - Math.abs(zoomChange) * .1);
					if (multiple < .1) multiple = .1;
					if (zoomChange > 0) { config.map.width /= multiple; } else { config.map.width *= multiple; }
					correctHeightRatio(config);
					var rect = canvas.getBoundingClientRect();
					var clickX = e.clientX - rect.left;
					var clickY = e.clientY - rect.top;
					clickX = clickX / rect.width * canvas.width;
					clickY = clickY / rect.height * canvas.height;
					config.map.x = (clickX * oldWidth - clickX * config.map.width) / canvas.width - (oldWidth - config.map.width) / 2 + config.map.x;
					config.map.y = (clickY * oldHeight - clickY * config.map.height) / canvas.height - (oldHeight - config.map.height) / 2 + config.map.y;
					zoomChange = 0;
					updateFields();
					render();
				}
			}, 200);
			return false;
		};
	})();
	document.getElementById('savedRenderings').onwheel = function(e) { this.scrollBy(e.deltaY, 0); };
	document.getElementById('demos').onwheel = function(e) { this.scrollBy(e.deltaY, 0); };
}

function initMouseClick() {
	canvas.onclick = function(e) {
		var rect = canvas.getBoundingClientRect();
		var clickX = (e.clientX - rect.left) / rect.width * canvas.width;
		var clickY = (e.clientY - rect.top) / rect.height * canvas.height;
		var leftX = config.map.x - config.map.width / 2;
		var topY = config.map.y - config.map.height / 2;
		config.map.x = clickX * config.map.width / canvas.width + leftX;
		config.map.y = clickY * config.map.height / canvas.height + topY;
		render();
	}
}

function initMouseDrag() {
	var dragStart = {},
		dragging = 0;
	canvas.onmousedown = function(e) {
		var rect = canvas.getBoundingClientRect();
		dragging = 1;
		dragStart.x = (e.clientX - rect.left) / rect.width * canvas.width;
		dragStart.y = (e.clientY - rect.top) / rect.height * canvas.height;
	}
	canvas.onmouseup = function(e) {
		if (!dragging) return;
		dragging = 0;
		var rect = canvas.getBoundingClientRect();
		var ex = (e.clientX - rect.left) / rect.width * canvas.width;
		var ey = (e.clientY - rect.top) / rect.height * canvas.height;
		var dx = (dragStart.x - ex) * config.map.width / canvas.width;
		var dy = (dragStart.y - ey) * config.map.height / canvas.height;
		config.map.x = config.map.x + dx;
		config.map.y = config.map.y + dy;
		updateFields();
		render();
	}
	canvas.onmouseleave = function() { dragging = 0; };
}

function initFieldUpdates() {
	var fields = {
		'xOffset': 'x',
		'yOffset': 'y',
		'width': 'width',
		'accuracy': 'accuracy',
		'maxRadius': 'maxRadius',
		'recursionDepth': 'recursionDepth'
	};
	for (var id in fields) {
		var el = document.getElementById(id);
		if (!el) continue;
		el.onchange = function(field) {
			return function() {
				if (isNaN(this.value)) { this.classList.add('error'); return; }
				this.classList.remove('error');
				var val = parseFloat(this.value);
				if (field == 'colourWavePeriod') {
					config.palette[field] = val;
					redraw();
				} else if (field == 'countOffset'){
					val = Math.round(val);
					this.value = val;
					config.options[field] = val;
					redraw();
				} else if (field == 'recursionDepth' || field == 'accuracy') {
					val = Math.round(val);
					if (field == 'recursionDepth' && val < 1) val = 1;
					if (field == 'accuracy' && val < 1) val = 1;
					this.value = val;
					config.options[field] = val;
					render();
				} else if (field == 'maxRadius') {
					config.options[field] = val;
					render();
				} else {
					config.map[field] = val;
					if (field == 'width') correctHeightRatio(config);
					render();
				}
			}
		}(fields[id]);
	}
}

function multiplyAccuracy(factor) {
	config.map.accuracy = Math.round(config.map.accuracy * factor);
	if (config.map.accuracy < 1) config.map.accuracy = 1;
	document.getElementById('accuracy').value = config.map.accuracy;
	render();
}

function initModifiers() {
	var endConditions = document.getElementsByName('endCondition');
	for (var n = 0; n < endConditions.length; n++) {
		endConditions[n].onchange = function() {
			config.options.endCondition = this.value;
			render();
		}
	}
	var flagMap = {
		'calculationIterations': 'iterations',
		'calculationDisplacement': 'displacement',
		'calculationRotation': 'rotation',
		'calculationXORDisplacement': 'displacementXOR',
		'calculationXORPolar': 'polarCoordXOR'
	};
	for (var id in flagMap) {
		var el = document.getElementById(id);
		if (!el) continue;
		el.onchange = function(f) {
			return function() {
				config.options.calculationFlags[f] = this.checked ? 1 : 0;
				redraw();
			}
		}(flagMap[id]);
	}
	var coeffMap = {
		'iterationCoefficient': 'iterations',
		'displacementCoefficient': 'displacement',
		'rotationCoefficient': 'rotation',
		'displacementXORCoefficient': 'displacementXOR',
		'polarCoordXORCoefficient': 'polarCoordXOR'
	};
	for (var id in coeffMap) {
		var el = document.getElementById(id);
		if (!el) continue;
		el.onchange = function(f) {
			return function() {
				config.options.coefficients[f] = parseFloat(this.value) || 0;
				redraw();
			}
		}(coeffMap[id]);
	}
}

// ============================================================================
// Palette wave preview
// ============================================================================
// Draws the three sine waves that createColour() uses for the palette, so the
// offset / stagger / period / wave-period controls can be tuned with visual
// feedback. Each channel is drawn twice: a solid line for the wave itself
// (offset + masterOffset + period + wavePeriod), and a light dashed line
// offset by that channel's own stagger contribution, showing how far the
// stagger can push the curve. The stagger is deliberately *not* drawn as a
// discontinuous on/off pattern - its input is the iteration count gated by
// the per-channel bitmask, which has no meaning as a function of a continuous
// x. The dashed line represents the "stagger is currently on" envelope
// instead; the actual on/off pattern is what the bitmask dialog controls.
//
// The x-axis spans a whole number of full cycles of the fastest channel at
// the current colourWavePeriod (clamped to a small range), so the graph stays
// readable whether the wave period is 8 or 800.
function drawPaletteGraph() {
	var container = document.getElementById('paletteGraph');
	var canvasEl = document.getElementById('paletteGraphCanvas');
	if (!container || !canvasEl) return;

	// Size the backing store to the CSS box, in device pixels.
	var cssW = container.clientWidth;
	var cssH = container.clientHeight;
	if (cssW < 4 || cssH < 4) return;
	var dpr = window.devicePixelRatio || 1;
	var w = Math.round(cssW * dpr);
	var h = Math.round(cssH * dpr);
	if (canvasEl.width !== w) canvasEl.width = w;
	if (canvasEl.height !== h) canvasEl.height = h;

	var ctx = canvasEl.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssW, cssH);

	var colourWavePeriod = Math.abs(config.palette.colourWavePeriod) || 64;

	// ---- x-axis range (UNCHANGED) ----
	// Auto-scaled to a small whole number of full cycles of the fastest
	// channel, exactly as before. This is what keeps the plotted wave shape
	// identical regardless of colourWavePeriod. The ruler notches below are
	// deliberately in absolute iteration-count units, so they *do* move as
	// colourWavePeriod changes even though the waves don't.
	var fastestPeriod = Math.max(
		config.palette.red.period || 1,
		config.palette.green.period || 1,
		config.palette.blue.period || 1
	);
	var targetFastCycles = 2;
	var baseCycles = Math.max(1, Math.round(targetFastCycles / fastestPeriod));
	baseCycles = Math.min(baseCycles, 8);
	var xMax = baseCycles * colourWavePeriod;

	var midY = cssH / 2;
	var amp = cssH * 0.42;
	var xAt = function (n) { return (n / xMax) * cssW; };

	// ---- ruler notches ----
	// Two tiers, like cm and mm. The spacing is chosen from a "nice numbers"
	// ladder (1, 2, 5, 10, ...) so that roughly `targetMajorCount` major
	// notches are visible across the current xMax. Because xMax is
	// proportional to colourWavePeriod, changing the period slides the fixed
	// iteration positions of the notches across the canvas - that's the
	// continuous feedback. When the density drifts too far from the target,
	// the ladder steps to the next nice value, which keeps the graph legible
	// at any period without altering the plotted waves.
	var targetMajorCount = 8;
	var desiredSpacing = xMax / targetMajorCount;
	var niceSteps = [1, 2, 5];
	var majorSpacing = 1;
	var bestScore = Infinity;
	for (var e = -3; e <= 7; e++) {
		for (var s = 0; s < niceSteps.length; s++) {
			var cand = niceSteps[s] * Math.pow(10, e);
			var score = Math.abs(Math.log(cand / desiredSpacing));
			if (score < bestScore) {
				bestScore = score;
				majorSpacing = cand;
			}
		}
	}

	// Minor notches subdivide each major interval into fifths (so a 10-unit
	// major gives 2-unit minors, a 50-unit major gives 10-unit minors, etc.).
	// If the minor pixel gap would be too tight to read, drop them entirely.
	var minorDivisions = 5;
	var minorSpacing = majorSpacing / minorDivisions;
	var minPixelGap = 5;
	if ((minorSpacing / xMax) * cssW < minPixelGap) {
		minorDivisions = 1;
		minorSpacing = majorSpacing;
	}

	var majorLen = Math.max(3, cssH * 0.30);
	var minorLen = Math.max(2, cssH * 0.15);

	// Minor notches first, so the major ones draw on top.
	if (minorDivisions > 1) {
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (var nm = 0; nm <= xMax + 1e-9; nm += minorSpacing) {
			// Skip positions coinciding with a major notch.
			var ratio = nm / majorSpacing;
			if (Math.abs(ratio - Math.round(ratio)) < 1e-6) continue;
			var xm = xAt(nm);
			ctx.moveTo(xm, 0);              ctx.lineTo(xm, minorLen);
			ctx.moveTo(xm, cssH - minorLen); ctx.lineTo(xm, cssH);
		}
		ctx.stroke();
	}

	// Major notches.
	ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (var nMaj = 0; nMaj <= xMax + 1e-9; nMaj += majorSpacing) {
		var xMaj = xAt(nMaj);
		ctx.moveTo(xMaj, 0);                ctx.lineTo(xMaj, majorLen);
		ctx.moveTo(xMaj, cssH - majorLen); ctx.lineTo(xMaj, cssH);
	}
	ctx.stroke();

	// Faint horizontal rules at -1, 0, +1.
	ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, midY - amp); ctx.lineTo(cssW, midY - amp);
	ctx.moveTo(0, midY);       ctx.lineTo(cssW, midY);
	ctx.moveTo(0, midY + amp); ctx.lineTo(cssW, midY + amp);
	ctx.stroke();

	// Amber marker at n = 0 (the unshifted phase reference).
	ctx.strokeStyle = 'rgba(242, 192, 94, 0.55)';
	ctx.beginPath();
	ctx.moveTo(xAt(0), 0); ctx.lineTo(xAt(0), cssH);
	ctx.stroke();

	// ---- waves (UNCHANGED) ----
	var masterOffset = config.palette.master.offset || 0;
	var masterStagger = config.palette.master.stagger || 0;
	var channels = [
		{ key: 'red',   colour: '#d64545' },
		{ key: 'green', colour: '#3aa64a' },
		{ key: 'blue',  colour: '#3a6ad6' }
	];

	// One sample per device pixel is plenty for a smooth curve.
	var samples = Math.max(2, Math.round(cssW * dpr));

	for (var c = 0; c < channels.length; c++) {
		var ch = channels[c];
		var pal = config.palette[ch.key];
		var period = pal.period || 1;
		var offset = (pal.offset || 0) + masterOffset;
		var staggerTotal = (pal.stagger || 0) + masterStagger;

		// Solid: the wave as drawn when the stagger contribution is 0.
		ctx.strokeStyle = ch.colour;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		for (var i = 0; i <= samples; i++) {
			var n = (i / samples) * xMax;
			var ang = 2 * Math.PI * n * period / colourWavePeriod;
			var y = Math.sin(ang + offset);
			var px = (i / samples) * cssW;
			var py = midY - y * amp;
			if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
		}
		ctx.stroke();

		// Dashed: the envelope when the stagger contribution is 1.
		if (staggerTotal !== 0) {
			ctx.save();
			ctx.strokeStyle = ch.colour;
			ctx.globalAlpha = 0.35;
			ctx.lineWidth = 1;
			ctx.setLineDash([2, 2]);
			ctx.beginPath();
			for (var j = 0; j <= samples; j++) {
				var n2 = (j / samples) * xMax;
				var ang2 = 2 * Math.PI * n2 * period / colourWavePeriod;
				var y2 = Math.sin(ang2 + offset + staggerTotal);
				var px2 = (j / samples) * cssW;
				var py2 = midY - y2 * amp;
				if (j === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
			}
			ctx.stroke();
			ctx.restore();
		}
	}
}
// Listeners only need to be attached once; initPaletteAdjusters() gets
// called again on every loadDefaults()/refreshAll() (e.g. loading a saved
// rendering), and without this guard each call would stack another set of
// listeners on top of the last.
var paletteAdjustersInitialized = false;

function initPaletteAdjusters() {
	var colours = ['red', 'green', 'blue', 'master'];
	var elements = {};
	for (var c of colours) {
		elements[c] = {
			offset: document.getElementById(c + 'Offset'),
			offsetText: document.getElementById(c + 'OffsetText'),
			stagger: document.getElementById(c + 'Stagger'),
			staggerText: document.getElementById(c + 'StaggerText'),
		};
		if (c != 'master') {
			// The per-channel period multipliers are now custom
			// value-adjuster widgets (see initValueAdjusters()).
			setAdjusterValue(c + 'Period', config.palette[c].period);
		}
	}
	for (var n in elements) {
		(function(n) {
			var element = elements[n];
			// Set current values (runs every call, so this stays in sync
			// whenever config is replaced wholesale, e.g. loading a saved
			// rendering or resetting to defaults)
			element.offset.value = config.palette[n].offset;
			element.offsetText.value = config.palette[n].offset;
			element.stagger.value = config.palette[n].stagger;
			element.staggerText.value = config.palette[n].stagger;

			if (paletteAdjustersInitialized) return; // listeners already attached

			// --- Offset ---
			element.offset.addEventListener('input', function() {
				var v = parseFloat(this.value) || 0;
				config.palette[n].offset = v;
				element.offsetText.value = v;
				drawPaletteGraph();
				scheduleRedraw();
			});
			element.offsetText.addEventListener('input', function() {
				var v = parseFloat(this.value) || 0;
				config.palette[n].offset = v;
				element.offset.value = v;
				drawPaletteGraph();
				scheduleRedraw();
			});

			// --- Stagger ---
			element.stagger.addEventListener('input', function() {
				var v = parseFloat(this.value) || 0;
				config.palette[n].stagger = v;
				element.staggerText.value = v;
				drawPaletteGraph();
				scheduleRedraw();
			});
			element.staggerText.addEventListener('input', function() {
				var v = parseFloat(this.value) || 0;
				config.palette[n].stagger = v;
				element.stagger.value = v;
				drawPaletteGraph();
				scheduleRedraw();
			});
		})(n);
	}
	paletteAdjustersInitialized = true;
}

// Allow the tab key to cycle within subsets of available fields, rather than
// the entire document.
function initFieldTabCycling() {
	['tab-offset', 'tab-stagger', 'tab-period', 'tab-calc', 'tab-other', 'mainParams'].forEach(function (paneId) {
		var pane = document.getElementById(paneId);
		if (!pane) return;

		pane.addEventListener('keydown', function (e) {
			if (e.key !== 'Tab') return;

			// only cycle between actual text/number input fields
			var fields = Array.prototype.filter.call(
				pane.querySelectorAll('input[type="text"], input[type="number"]'),
				function (el) { return el.offsetParent !== null && !el.disabled; }
			);
			if (!fields.length) return;

			var idx = fields.indexOf(e.target);
			if (idx === -1) return; // focus is somewhere else in the pane - let Tab behave normally

			e.preventDefault();
			var next = e.shiftKey
				? (idx - 1 + fields.length) % fields.length
				: (idx + 1) % fields.length;
			fields[next].focus();
			fields[next].select(); // so typing replaces rather than appends - drop if you'd rather not
		});
	});
}

// ---- section collapse helpers ----
function recalcSectionHeights() {
	var bodies = document.querySelectorAll('.section-body');
	for (var body of bodies) {
		if (body.classList.contains('open')) {
			body.style.maxHeight = body.scrollHeight + 20 + 'px';
		} else {
			body.style.maxHeight = '0';
		}
	}
}

function initTabBars() {
	// modifier tabs
	var modTabs = document.querySelectorAll('#modifierTabs .tab-btn');
	for (var t of modTabs) {
		t.onclick = function() {
			var parent = this.closest('.section-body');
			parent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
			this.classList.add('active');
			parent.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
			var pane = parent.querySelector('#tab-' + this.dataset.tab);
			if (pane) pane.classList.add('active');
			recalcSectionHeights();
		};
	}
	// palette tabs
	var palTabs = document.querySelectorAll('#paletteTabs .tab-btn');
	for (var t of palTabs) {
		t.onclick = function() {
			var parent = this.closest('.section-body');
			parent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
			this.classList.add('active');
			parent.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
			var pane = parent.querySelector('#tab-' + this.dataset.tab);
			if (pane) pane.classList.add('active');
			recalcSectionHeights();
		};
	}
	// footer tabs
	var ftTabs = document.querySelectorAll('#footerTabs .tab-btn');
	var savedStrip = document.getElementById('savedRenderings');
	var demosStrip = document.getElementById('demos');
	for (var t of ftTabs) {
		t.onclick = function() {
			ftTabs.forEach(b => b.classList.remove('active'));
			this.classList.add('active');
			if (this.dataset.tab == 'saved') {
				savedStrip.style.display = 'flex';
				demosStrip.style.display = 'none';
			} else {
				savedStrip.style.display = 'none';
				demosStrip.style.display = 'flex';
			}
		};
	}
	// section collapse
	var headers = document.querySelectorAll('.section-header[data-toggle]');
	for (var h of headers) {
		h.onclick = function() {
			var body = this.nextElementSibling;
			if (body && body.classList.contains('section-body')) {
				var isOpen = body.classList.contains('open');
				if (isOpen) {
					body.classList.remove('open');
					body.style.maxHeight = '0';
					body.style.paddingTop = '0';
					body.style.paddingBottom = '0';
					body.style.opacity = '0';
					this.classList.add('collapsed');
				} else {
					body.classList.add('open');
					body.style.maxHeight = body.scrollHeight + 20 + 'px';
					body.style.paddingTop = '0.6rem';
					body.style.paddingBottom = '0.8rem';
					body.style.opacity = '1';
					this.classList.remove('collapsed');
				}
				if (this.parentElement.dataset.section === 'palette') {
					setTimeout(drawPaletteGraph, 320);
				}
			}
		};
		// init: ensure open bodies have max-height set
		var body = h.nextElementSibling;
		if (body && body.classList.contains('section-body')) {
			if (body.classList.contains('open')) {
				body.style.maxHeight = body.scrollHeight + 20 + 'px';
				body.style.paddingTop = '0.6rem';
				body.style.paddingBottom = '0.8rem';
				body.style.opacity = '1';
			} else {
				body.style.maxHeight = '0';
				body.style.paddingTop = '0';
				body.style.paddingBottom = '0';
				body.style.opacity = '0';
			}
		}
	}
}

// Builds the custom slider widgets. Must run after the DOM exists and before
// anything calls updateFields()/initPaletteAdjusters().
function initValueAdjusters() {
	valueAdjusters.countOffset = valueAdjuster(document.getElementById('countOffset'), {
		indicatorStyle: 'handle',
		displayElement: document.getElementById('countOffsetDisplay'),
		stepSize: 1,
		onAdjust: function (newValue) {
			config.options.countOffset = newValue;
			if (!suppressAdjusterSync) scheduleRedraw();
		}
	});

	valueAdjusters.numcolours = valueAdjuster(document.getElementById('numcolours'), {
		indicatorStyle: 'handle',
		displayElement: document.getElementById('numcoloursDisplay'),
		onAdjust: function (newValue) {
			config.palette.colourWavePeriod = newValue;
			drawPaletteGraph();
			if (!suppressAdjusterSync) scheduleRedraw();
		}
	});

	['red', 'green', 'blue'].forEach(function (primary) {
		valueAdjusters[primary + 'Period'] = valueAdjuster(document.getElementById(primary + 'Period'), {
			indicatorStyle: 'handle',
			displayElement: document.getElementById(primary + 'PeriodText'),
			onAdjust: function (newValue) {
				config.palette[primary].period = newValue;
				drawPaletteGraph();
				if (!suppressAdjusterSync) scheduleRedraw();
			}
		});
	});
}

// Pushes a value into one of the widgets without triggering its onAdjust
// callback. Used when the config is replaced wholesale (loading a saved
// rendering, resetting to defaults, reading a URL) so we don't fire a redraw
// per field.
function setAdjusterValue(name, v) {
	var adjuster = valueAdjusters[name];
	if (!adjuster) return;
	var previous = suppressAdjusterSync;
	suppressAdjusterSync = true;
	adjuster.setValue(v);
	suppressAdjusterSync = previous;
}

/* This function is used to handle backwards compatability with old saved
 * renderings.  The structure in which they're stored has been modified
 * multiple times and will continue to be so.  This allows old renderings to be
 * retained. */
function updateOldStoredData(){
	let renderings = JSON.parse(localStorage.getItem('renderings'));
	if (!renderings) return;
	let numRenderings = Object.keys(renderings).length;


	for(let n = 0; n < numRenderings; n++){
		// Account for old versions having "maxColourIndex" or having
		// "colourWavePeriod" stored with the mandelbrot info instead of the
		// palette info.
		if(renderings[n].palette.colourWavePeriod == undefined){
			if(renderings[n].map.colourWavePeriod != undefined){
				renderings[n].palette.colourWavePeriod = renderings[n].map.colourWavePeriod;
			}else if(renderings[n].map.maxColourIndex != undefined){
				renderings[n].palette.colourWavePeriod = renderings[n].map.maxColourIndex;
			}else{
				renderings[n].palette.colourWavePeriod = defaultConfig.palette.colourWavePeriod;
			}
		}

		// While we're here, update for old copies missing the wave period settings
		for(let primary of ['red', 'green', 'blue']){
			if(renderings[n].palette[primary].period == undefined){
				renderings[n].palette[primary].period = 1;
			}
		}

		// Handle the migration from distinct colour calculation types to separate boolean options for each modification
		if(renderings[n].options.calculationFlags == undefined){
			renderings[n].options.calculationFlags = JSON.parse(JSON.stringify(defaultConfig.options.calculationFlags));
			if(renderings[n].options.calculationMethod != undefined){
				switch(renderings[n].options.calculationMethod){
					case 'countPlusDisplacement':
						renderings[n].options.calculationFlags.displacement = 1;
						break;
					case 'countPlusDisplacementAngle':
						renderings[n].options.calculationFlags.rotation = 1;
						break;
					case 'countPlusAnglePlusRadius':
						renderings[n].options.calculationFlags.displacement = 1;
						renderings[n].options.calculationFlags.rotation = 1;
						break;
					case 'countXORDisplacement':
						renderings[n].options.calculationFlags.displacementXOR = 1;
						break;
					case 'classic':
						// we just stick with the already set defaults
						break;
					default:
						throw "updateOldStoredData: Unhandled configuration";
				}
			}
		}

		// Add the new coefficients section in options
		if(renderings[n].options.coefficients == undefined){
			renderings[n].options.coefficients = JSON.parse(JSON.stringify(defaultConfig.options.coefficients));
		}

		// Add the new stagger bitmask
		if(renderings[n].palette.staggerMask == undefined){
			renderings[n].palette.staggerMask = JSON.parse(JSON.stringify(defaultConfig.palette.staggerMask));
		}

		// add the new recursion option
		if(renderings[n].options.recursionDepth == undefined){
			renderings[n].options.recursionDepth = 1;
		}

		// add the new maximum radius option
		if(renderings[n].options.maxRadius == undefined){
			renderings[n].options.maxRadius = defaultConfig.options.maxRadius;
		}

		// add the new countOffset option
		if(renderings[n].options.countOffset == undefined){
			renderings[n].options.countOffset = 0;
		}

		// switch the way stagger timing is stored
		if(renderings[n].options.staggerBefore == undefined){
			if(renderings[n].options.staggerTiming == "before"){
				renderings[n].options.staggerBefore = 1;
				renderings[n].options.staggerAfter = 0;
			}else if(renderings[n].options.staggerTiming == "after"){
				renderings[n].options.staggerBefore = 0;
				renderings[n].options.staggerAfter = 1;
			}else if(renderings[n].options.staggerTiming == "both"){
				renderings[n].options.staggerBefore = 1;
				renderings[n].options.staggerAfter = 1;
			}
		}

		delete renderings[n].options.staggerTiming;
	}


	// write the updates back to localStorage
	localStorage.setItem('renderings', JSON.stringify(renderings));
}

function resizeCanvas() {
	var area = document.getElementById('canvasArea');
	var rect = area.getBoundingClientRect();
	var w = Math.floor(rect.width);
	var h = Math.floor(rect.height);
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w || 1;
		canvas.height = h || 1;
		correctHeightRatio(config);
		render();
	}
	drawPaletteGraph();
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- initialise ----
function initialize() {
	// load config
	config = JSON.parse(JSON.stringify(defaultConfig));

	if (window.location.search != '') {
		var params = window.location.search.slice(1).split('&').map(function(kv) { return kv.split('=', 2); });
		for (var n in params) {
			if (params[n][0] == 'config') {
				var raw = decodeURIComponent(params[n][1] || '');
				try {
					if (raw.startsWith('v1,')) {
						config = deserializeConfig(raw);
					} else {
						config = JSON.parse(atob(raw));
					}
					// Apply any schema migrations (ensures old fields exist)
					migrateSingleRendering(config);
				} catch(e) {
					// If parsing fails, keep the default config
				}
				break;
			}
		}
	}

	// canvas
	canvas = document.getElementById('mainCanvas');
	var area = document.getElementById('canvasArea');
	var rect = area.getBoundingClientRect();
	canvas.width = Math.floor(rect.width) || 800;
	canvas.height = Math.floor(rect.height) || 600;
	context = canvas.getContext('2d');

	// ensure canvas fills area on resize
	var ro = new ResizeObserver(function() { resizeCanvas(); });
	ro.observe(area);
	window.addEventListener('resize', function() { setTimeout(resizeCanvas, 100); });
	sleep(5000);	
	correctHeightRatio(config);
	initValueAdjusters();
	render();
	updateFields();
	drawPaletteGraph();

	initMouseWheel();
	initMouseDrag();
	initMouseClick();
	initFieldUpdates();
	initPaletteAdjusters();
	initModifiers();
	initTabBars();
	initFieldTabCycling();

	// Update localStorage data (but keep it) – do this before migration
	updateOldStoredData();

	// UI buttons (top bar actions)
	document.getElementById('resetViewBtn').onclick = function(e){
		e.stopPropagation();
		resetMandelbrot();
	}
	document.getElementById('saveBtn').onclick = saveLocation;
	document.getElementById('urlBtn').onclick = URLPopup;
	document.getElementById('exportBtn').onclick = exportImage;
	document.getElementById('loadDefaultsBtn').onclick = loadDefaults;
	document.getElementById('showIntroBtn').onclick = showWelcomeWindow;

	document.querySelectorAll('.multiplier-btn[data-multiply]').forEach(function(b) {
		b.onclick = function() { multiplyAccuracy(parseFloat(this.dataset.multiply)); };
	});

	document.getElementById('accuracy').onchange = function(){
		config.map.accuracy = Math.round(this.value);
		if (config.map.accuracy < 1) config.map.accuracy = 1;
		render();
	}

	// Edit Bitmask button
	document.getElementById('editBitmaskBtn').onclick = editBitmask;

	// stagger timing checkboxes
	document.getElementById('staggerBefore').onclick = function(){
		config.options.staggerBefore = this.checked ? 1 : 0;
		redraw();
	}

	document.getElementById('staggerAfter').onclick = function(){
		config.options.staggerAfter = this.checked ? 1 : 0;
		redraw();
	}

	// on mobile, click outside to close
	document.getElementById('canvasArea').addEventListener('click', function(e) {
		if (window.innerWidth < 600 && sidebar.classList.contains('open')) {
			sidebar.classList.remove('open');
			sidebarOpen = false;
			sidebar.classList.add('collapsed');
			setTimeout(resizeCanvas, 350);
		}
	});

	// render saved & samples (async)
	renderSavedLocations().then(function() {
		// After saved renderings loaded, load samples (they are not stored)
		renderSampleLocations();
	}).catch(function(e) {
		console.warn('Error loading saved renderings, showing samples anyway', e);
		renderSampleLocations();
	});
}

window.onload = function() { initialize(); };

// expose some functions for inline onclick compatibility
window.resetMandelbrot = resetMandelbrot;
window.multiplyAccuracy = multiplyAccuracy;
window.saveLocation = saveLocation;
window.URLPopup = URLPopup;
window.exportImage = exportImage;
window.loadDefaults = loadDefaults;
window.showPaletteInfo = showPaletteInfo;
window.editBitmask = editBitmask;
window.closePopup = closePopup;
window.popup = popup;
