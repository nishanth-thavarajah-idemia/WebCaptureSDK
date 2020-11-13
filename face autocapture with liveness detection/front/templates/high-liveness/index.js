/*
Copyright 2020 Idemia Identity & Security

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// this file is the main program that uses video server api for high liveness

const lottie = require('lottie-web/build/player/lottie_light.js');
const commonutils = require('../../utils/commons');
// define html elements
const videoOutput = document.querySelector('#user-video');

const stopCaptureButton = document.querySelector('#stop-capture');
const tutorialVideoPlayer = document.querySelector('#video-player');
const stopTutorialButton = document.querySelector('#stop-tutorial');
const headRotationAnimation = document.querySelector('#head-rotation-animation');
const moveHeadMsg = document.querySelector('#move-head-animation');
const positiveMessage = document.querySelector('#positive-message');
const authenticationInProgress = document.querySelector('#authentication-in-progress');

const getIpvTransactionButton = document.querySelector('#get-ipv-transaction');
const getIpvPortraitButton = document.querySelector('#get-ipv-portrait');

const switchCameraButton = document.querySelector('#switch-camera');
const headStartPositionOutline = document.querySelector('#center-head-animation');

const moveCloserMsg = document.querySelector('#move-closer-animation');
const moveFurtherMsg = document.querySelector('#move-further-animation');

const movingPhoneMsg = document.querySelector('#move-phone-animation');
const phoneNotVerticalMsg = document.querySelector('#phone-not-vertical-animation');
const loadingChallenge = document.querySelector('#loading-challenge');
const illuminationOverlay = document.querySelector('#illumination-overlay');
const bestImgElement = document.querySelector('#step-liveness-ok .best-image');
const selfieInput = document.querySelector('#selfieInput');
const videoMsgOverlays = document.querySelectorAll('#step-liveness .video-overlay');

let timeoutCheckConnectivity; // settimeout used to stop if network event received
let connectivityOK = false;
let client; // let start & stop face capture
let videoStream; // user video camera stream
let videoMediaDevices; // list of user camera devices
let sessionId; // current sessionId
let bestImageId; // best image captured from user video stream
let bestImageURL; // best image url (in memory window.URL.createObjectURL)
let currentDeviceIndex; // index of the camera currently used in face capture
let cameraPermissionAlreadyAsked;
let identityId;

const urlParams = new URLSearchParams(window.location.search); // let you extract params from url
const isMatchingEnabled = urlParams.get('enableMatching') === 'true';
const isVideoTutEnabled = urlParams.get('videoTutorial') === 'true';
const isGifOverlayEnabled = urlParams.get('gifOverlay') === 'true';


const sessionIdParam = urlParams.get('sessionId');
const identityIdParam = urlParams.get('identityId');

const basePath = BASE_PATH;
const videoUrlWithBasePath = VIDEO_URL + VIDEO_BASE_PATH;
const videoBasePath = VIDEO_BASE_PATH;
const videoUrl = VIDEO_URL;
const enablePolling = !DISABLE_CALLBACK;
const idProofingWorkflow = IDPROOFING;

/**
 * 1- init liveness session (from backend)
 * 2- init the communication with the server via webrtc & socket
 * 3- get liveness result (from backend)
 * 4- [Optional] ask the end user to push his reference image (post to backend)
 * 5- [Optional] get the matching result between the best image from webRTC and the reference image
 */
async function init(options = {}) {
  client = undefined;
  initLivenessDesign();
  // get user camera video (front camera is default)
  videoStream = await BioserverVideo.getDeviceStream({video: {deviceId: options.deviceId}})
    .catch((e) => {
      let msg = __('Failed to get camera device stream');
      let extendedMsg;
      if (e.name && e.name.indexOf('NotAllowed') > -1) {
        msg = __('You denied camera permissions, either by accident or on purpose.');
        extendedMsg = __('In order to use this demo, you need to enable camera permissions in your browser settings or in your operating system settings.');
      }
      stopVideoCaptureAndProcessResult(false, msg, '', extendedMsg);
    });
  if (!videoStream) return;
  // display the video stream
  videoOutput.srcObject = videoStream;

  // request a sessionId from backend (if we are switching camera we use the same session)
  if (!sessionId || !options.switchCamera) {
    const session = await commonutils.initLivenessSession(basePath, sessionIdParam || '', identityIdParam || '')
      .catch(() => {
        sessionId = false;
        stopVideoCaptureAndProcessResult(false, __('Failed to initialize session'));
      });
    sessionId = session.sessionId;
    identityId = session.identityId;
  }
  if (!sessionId) return;
  // initialize the face capture client with callbacks
  let challengeInProgress = false;
  let challengePending = false;
  const faceCaptureOptions = {
    bioSessionId: sessionId,
    identityId: identityId,
    showChallengeInstruction: (challengeInstruction) => {
      if (challengeInstruction === 'TRACKER_CHALLENGE_PENDING') {
        // pending ==> display waiting msg meanwhile the showChallengeResult callback is called with result
        challengeInProgress = false;
        challengePending = true
        BioserverVideoUI.resetLivenessHighGraphics();
        headRotationAnimation.classList.add('d-none-fadeout');
        authenticationInProgress.classList.remove('d-none-fadeout');
      } else { // challengeInstruction == TRACKER_CHALLENGE_2D
        challengeInProgress = true;
        switchCameraButton.classList.add('d-none'); // once the challenge started user can not switch camera
        // display challenge
        let options = {
          tooltip: {
            enabled: true,
            text: __("Move the line with your head to this point")
          },
        };
        BioserverVideoUI.resetLivenessHighGraphics(options);
      }
    },
    showChallengeResult: async () => {
      console.log('Liveness Challenge done > requesting result ...');
      const result = await commonutils.getLivenessChallengeResult(basePath, enablePolling, sessionId)
        .catch(() => stopVideoCaptureAndProcessResult(false, __('Failed to retrieve liveness results')));
      if (result) stopVideoCaptureAndProcessResult(result.isLivenessSucceeded, result.message, result.bestImageId);
      if (client) client.disconnect();
    },
    trackingFn: (trackingInfo) => {
      if (!challengePending) { // tracking info can be received  after challengeInstruction === 'TRACKER_CHALLENGE_PENDING'
        // In this case , skip received tracking message
        displayInstructionsToUser(trackingInfo, challengeInProgress);
        if (trackingInfo.colorDisplay) {
          displayIlluminationOverlay(trackingInfo.colorDisplay, 0);
        }
        BioserverVideoUI.updateLivenessHighGraphics('user-video', trackingInfo);
      }
    },
    errorFn: (error) => {
      console.log('got error', error);
      challengeInProgress = false;
      stopVideoCaptureAndProcessResult(false, __('Sorry, there was an issue.'));
      if (client) client.disconnect();
    }
  };
  faceCaptureOptions.wspath = videoBasePath + '/engine.io';
  faceCaptureOptions.bioserverVideoUrl = videoUrl;
  faceCaptureOptions.rtcConfigurationPath = videoUrlWithBasePath + '/coturnService?bioSessionId=' + encodeURIComponent(sessionId);
  client = await BioserverVideo.initFaceCaptureClient(faceCaptureOptions);
}

/**
 * Button stop activated
 **/
stopCaptureButton.addEventListener('click', async () => {
  resetLivenessDesign();
  if (client) client.disconnect();
});

/**
 * Get GIPS Transaction Button activated
 **/
getIpvTransactionButton.addEventListener('click', async () => {
  console.log("calling getGipsStatus with identityId=" + identityId);
  document.querySelector('#get-ipv-status-result').innerHTML = "";
  const result = await commonutils.getGipsStatus(basePath, identityId);
  console.log("result IPV response" + result);
  document.querySelector('#get-ipv-status-result').innerHTML = JSON.stringify(result, null, 4);
  document.querySelector(`#get-ipv-status-result`).classList.remove('d-none');
});


/**
 * Get GIPS Transaction Button activated
 **/
getIpvPortraitButton.addEventListener('click', async () => {
  console.log("calling getIpvPortraitButton ");
  document.querySelector('#best-image-ipv').src = "";
  const faceImg = await commonutils.getFaceImage(basePath, sessionId, bestImageId);
  bestImageURL = window.URL.createObjectURL(faceImg);
  document.querySelector('#best-image-ipv').src = `${bestImageURL}`;
  document.querySelector(`#best-image-ipv`).classList.remove('d-none');
});

/**
 * Select another device camera
 **/
switchCameraButton.addEventListener('click', async () => {
  if (client) {
    try {
      switchCameraButton.classList.add('d-none');
      // retrieve user cameras
      if (!videoMediaDevices) {
        const mediaDevices = await BioserverVideo.initMediaDevices();
        videoMediaDevices = mediaDevices.videoDevices.map((d) => d.deviceId);
      }
      if (!videoMediaDevices || videoMediaDevices.length === 1) { // << we do not switch camera if only 1 camera found
        switchCameraButton.classList.remove('d-none');
        return;
      }
      if (client) {
        videoOutput.srcObject = null; // this line can avoid some freeze when changing camera from front to back
        client.disconnect();
      }
      resetLivenessDesign();
      console.log('video devices: ', {videoMediaDevices});
      const videoTrack = videoStream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      console.log('video track settings: ', {settings});
      let currentDeviceId = settings.deviceId; // not all browsers support this
      const index = currentDeviceId ? videoMediaDevices.indexOf(currentDeviceId) : currentDeviceIndex ? currentDeviceIndex + 1 : 0;
      if (videoMediaDevices.length > 1) {
        if (index < videoMediaDevices.length - 1) {
          currentDeviceIndex = index + 1;
        } else {
          currentDeviceIndex = 0;
        }
      }
      // get next camera id (loop over user cameras)
      currentDeviceId = videoMediaDevices[currentDeviceIndex];
      await init({deviceId: currentDeviceId, switchCamera: true});
      if (client) {
        setTimeout(() => {
          client.start(videoStream);
          switchCameraButton.classList.remove('d-none');
        }, 2000);
      }
    } catch (e) {
      stopVideoCaptureAndProcessResult(false, __('Failed to switch camera'));
    }
  }
});

/**
 * End of tutorial
 **/
stopTutorialButton.addEventListener('click', async () => {
  tutorialVideoPlayer.pause();
});
tutorialVideoPlayer.addEventListener('ended', () => {
  stopTutorialButton.click();
}, false);

// when next button is clicked go to targeted step
document.querySelectorAll('*[data-target]')
  .forEach((btn) => btn.addEventListener('click', async () => {
    let targetStepId = btn.getAttribute('data-target');
    if (targetStepId === '#step-1' || targetStepId === '#step-end-tutorial') {
      targetStepId = '#step-liveness';
    }
    await processStep(targetStepId, btn.hasAttribute('data-delay') && (btn.getAttribute('data-delay') || 2000))
      .catch(() => stopVideoCaptureAndProcessResult(false));
  }));

async function processStep(targetStepId, displayWithDelay) {
  // init debug ipv
  document.querySelector(`#best-image-ipv`).classList.add('d-none');
  document.querySelector(`#get-ipv-status-result`).classList.add('d-none');

  // d-none all steps
  document.querySelectorAll('.step').forEach(row => row.classList.add('d-none'));
  if (targetStepId === '#step-tutorial') {
    // start playing tutorial video (from the beginning)
    tutorialVideoPlayer.currentTime = 0;
    tutorialVideoPlayer.play();
  } else if (targetStepId === '#connectivity-check') { // << if client clicks on start capture or start training
    if (!connectivityOK) { // bypass this waiting time if we are still here 5 seconds
      document.querySelector('#connectivity-check').classList.remove('d-none');
      timeoutCheckConnectivity = setTimeout(() => {
        processStep(targetStepId, displayWithDelay)
      }, 1000); //call this method until we got the results from the network connectivity
    } else {
      targetStepId = '#step-liveness'; // connectivity check done/failed, move to the next step
    }
  }

  if (targetStepId === '#step-liveness') { // << if client clicks on start capture or start training
    if (!cameraPermissionAlreadyAsked) {// << display the camera access permission step the first time only
      cameraPermissionAlreadyAsked = true;
      targetStepId = '#step-access-permission';
      // when client accepts camera permission access > we redirect it to the liveness check
      document.querySelector(`${targetStepId} button`).classList.add('start-capture');
    } else {
      document.querySelector('#step-liveness').classList.remove('d-none');
      document.querySelector('#step-liveness .header').classList.add('d-none');
      await init();
      if (client) {
        setTimeout(() => {
          client.start(videoStream);
          switchCameraButton.classList.remove('d-none');
          document.querySelector('#step-liveness .header').classList.remove('d-none');
        }, 2000);
      } else return; // no client > no process
    }
  }
  const targetStep = document.querySelector(targetStepId);
  targetStep.classList.remove('d-none');
  const targetStepFooter = targetStep.querySelector('.footer');
  if (targetStepFooter) {
    targetStepFooter.classList.add('d-none');
    if (displayWithDelay) {
      // display next button after few seconds
      setTimeout(() => targetStepFooter.classList.remove('d-none'), displayWithDelay);
    } else {
      targetStepFooter.classList.remove('d-none')
    }
  }
}

document.querySelector('#step-liveness .tutorial').addEventListener('click', async () => {
  resetLivenessDesign();
  if (client) {
    client.disconnect();
  }
});
// gif animations are played only once, this will make them play again
document.querySelectorAll('.reset-animations').forEach((btn) => {
  btn.addEventListener('click', () => {
    refreshImgAnimations();
  });
});

function refreshImgAnimations() {
  // reload only gif animations
  document.querySelectorAll('.step > .animation > img').forEach((img) => {
    const gifAnimation = img.src.split('?')[0];
    if (gifAnimation.endsWith('.gif')) img.src = `${gifAnimation}?v=${Math.random()}`;
  });
}

/**
 * suspend video camera and return result
 */
async function stopVideoCaptureAndProcessResult(success, msg, faceId = '', extendedMsg) {
  bestImageId = faceId;
  // we reset the session when we finished the liveness check real session
  resetLivenessDesign();
  document.querySelectorAll('.step').forEach((step) => step.classList.add('d-none'));

  if (success) {
    document.querySelector('#step-liveness-ok').classList.remove('d-none');
    document.querySelectorAll('#step-liveness-ok button').forEach((btn) => btn.classList.add('d-none'));
    if (!idProofingWorkflow) {
      const faceImg = await commonutils.getFaceImage(basePath, sessionId, faceId);
      bestImageURL = window.URL.createObjectURL(faceImg);
      bestImgElement.style.backgroundImage = `url(${bestImageURL})`;
      document.querySelector(".success-no-ipv").classList.remove('d-none');
    } else {
      document.querySelector(".success-ipv").classList.remove('d-none');
      document.querySelector(`#get-ipv-transaction`).classList.remove('d-none');
      document.querySelector(`#get-ipv-portrait`).classList.remove('d-none');
    }
    const nextButton = isMatchingEnabled ? 'next-step' : 'reset-step';

    document.querySelectorAll(`#step-liveness-ok button.${nextButton}`).forEach((step) => step.classList.remove('d-none'));
  } else if (msg && (msg.indexOf('Timeout') > -1 || msg.indexOf('failed') > -1)) {
    if (!sessionStorage.getItem("livenessResult")) {
      sessionStorage.setItem("livenessResult", "1");
      document.querySelector('#step-liveness-timeout').classList.remove('d-none');
      document.querySelector('#step-liveness-timeout .footer').classList.add('d-none');
      setTimeout(() => {
        document.querySelector('#step-liveness-timeout .footer').classList.remove('d-none');
      }, 12000);

    } else {
      document.querySelector('#step-liveness-failed').classList.remove('d-none');
      document.querySelector('#step-liveness-failed .footer').classList.add('d-none');
      setTimeout(() => {
        //document.querySelector('#step-liveness-failed .footer').classList.remove('d-none');
      }, 6000);
    }
  } else {
    document.querySelector('#step-liveness-ko').classList.remove('d-none');
    if (msg) document.querySelector('#step-liveness-ko .description').textContent = __('Liveness failed');
    const small = document.querySelector('#step-liveness-ko small');
    small.textContent = (extendedMsg && extendedMsg !== 'blur') ? extendedMsg : '';
  }
}

/**
 * prepare video capture elements
 * @param trainingModeEnabled
 */
function initLivenessDesign(trainingModeEnabled) {
  document.querySelector('header').classList.add('d-none');
  document.querySelector('main').classList.add('darker-bg');
  switchCameraButton.classList.add('d-none');
  videoMsgOverlays.forEach((overlay) => overlay.classList.add('d-none-fadeout'));
  headStartPositionOutline.classList.remove('d-none-fadeout');
}

/**
 * reset video capture elements at the end of the process
 */
function resetLivenessDesign() {
  BioserverVideoUI.resetLivenessHighGraphics();
  document.querySelector('header').classList.remove('d-none');
  document.querySelector('main').classList.remove('darker-bg');
  if (bestImageURL) window.URL.revokeObjectURL(bestImageURL); // free memory
  bestImgElement.style.backgroundImage = null;
  headRotationAnimation.style.backgroundImage = null;
  switchCameraButton.classList.add('d-none');
  if (headAnimationOn || headAnimationOff) {
    window.clearTimeout(headAnimationOn);
    window.clearTimeout(headAnimationOff);
    headRotationAnimation.classList.add('d-none-fadeout');
  }
  lastChallengeIndex = -1;
}

/**
 * display messages to user during capture (eg: move closer, center your face ...)
 * @param trackingInfo face tracking info
 * @param challengeInProgress challenge has started?
 * @param trainingMode training mode enabled ?
 */
let lastChallengeIndex = -1;
let headAnimationOn;
let headAnimationOff;
let userInstructionMsgDisplayed;
let userInstructionMsgToDisplay;

function displayInstructionsToUser(trackingInfo, challengeInProgress) {
  if (trackingInfo.phoneNotVertical && !userInstructionMsgDisplayed) { // << user phone not up to face
    videoMsgOverlays.forEach((overlay) => overlay.classList.add('d-none-fadeout'));
    phoneNotVerticalMsg.classList.remove('d-none-fadeout');
    if (userInstructionMsgToDisplay) userInstructionMsgToDisplay = window.clearTimeout(userInstructionMsgToDisplay);
    userInstructionMsgToDisplay = window.setTimeout(() => {
      userInstructionMsgToDisplay = false
    }, 3000);
  } else if (trackingInfo.tooFar && !userInstructionMsgDisplayed) { // << user face found but too far from camera
    videoMsgOverlays.forEach((overlay) => overlay.classList.add('d-none-fadeout'));
    moveCloserMsg.classList.remove('d-none-fadeout');
  } else if (trackingInfo.tooClose && !userInstructionMsgDisplayed) { // << user face found but too close from camera
    videoMsgOverlays.forEach((overlay) => overlay.classList.add('d-none-fadeout'));
    moveFurtherMsg.classList.remove('d-none-fadeout');
  } else {
    const livenessHighData = trackingInfo.livenessHigh;
    if (trackingInfo.faceh === 0 && trackingInfo.facew === 0 && !userInstructionMsgDisplayed) { // << no face detected
      videoMsgOverlays.forEach((overlay) => overlay.classList.add('d-none-fadeout'));
      headStartPositionOutline.classList.remove('d-none-fadeout');
    } else if (livenessHighData
      && (livenessHighData.stillFace || livenessHighData.movingPhone) // << user not moving his head or moving his phone
      && !userInstructionMsgDisplayed
      && !userInstructionMsgToDisplay) {
      videoMsgOverlays.forEach((overlay) => overlay.classList.add('d-none-fadeout'));
      userInstructionMsgToDisplay = true;
      if (livenessHighData.stillFace) {
        moveHeadMsg.classList.remove('d-none-fadeout');
        userInstructionMsgDisplayed = window.setTimeout(() => {
          moveHeadMsg.classList.add('d-none-fadeout');
          userInstructionMsgDisplayed = window.clearTimeout(userInstructionMsgDisplayed);
          window.setTimeout(() => {
            userInstructionMsgToDisplay = false
          }, 5000)
        }, 5000);
      } else {
        movingPhoneMsg.classList.remove('d-none-fadeout');
        userInstructionMsgDisplayed = window.setTimeout(() => {
          movingPhoneMsg.classList.add('d-none-fadeout');
          userInstructionMsgDisplayed = window.clearTimeout(userInstructionMsgDisplayed);
          window.setTimeout(() => {
            userInstructionMsgToDisplay = false
          }, 5000)
        }, 5000);
      }
    } else if (!userInstructionMsgDisplayed) { // display challenge instruction
      document.querySelectorAll('#step-liveness .video-overlay')
        .forEach(overlay =>
          ![headRotationAnimation.id, positiveMessage.id].includes(overlay.id)
          && overlay.classList.add('d-none-fadeout'));
      if (challengeInProgress) {
        if (livenessHighData) {
          if (livenessHighData.targetOnHover && (headAnimationOn || headAnimationOff)) {
            window.clearTimeout(headAnimationOn);
            window.clearTimeout(headAnimationOff);
            headRotationAnimation.classList.add('d-none-fadeout');
          }
          if (livenessHighData.targetChallengeIndex !== lastChallengeIndex) {
            lastChallengeIndex = livenessHighData.targetChallengeIndex;
            if (lastChallengeIndex === 1) { // << if first point done display positive message and hide it after 3 seconds
              positiveMessage.classList.remove('d-none-fadeout');
              setTimeout(() => {
                positiveMessage.classList.add('d-none-fadeout');
              }, 3000);
            }
            if (isGifOverlayEnabled) { // display animated face overlay
              if (headAnimationOn || headAnimationOff) {
                window.clearTimeout(headAnimationOn);
                window.clearTimeout(headAnimationOff);
                headRotationAnimation.classList.add('d-none-fadeout');
              }
              headAnimationOn = window.setTimeout(() => {
                const pos = livenessHighData.challengeCircles[livenessHighData.targetChallengeIndex].pos;
                headRotationAnimation.style.backgroundImage = `url(./img/rotate_head_${pos}.gif)`;
                if (!livenessHighData.targetOnHover) {
                  headRotationAnimation.classList.remove('d-none-fadeout');
                  headAnimationOff = setTimeout(() => {
                    headRotationAnimation.classList.add('d-none-fadeout');
                  }, 3000)
                }
              }, 3000);
            }
          }
        }
      } else {
        loadingChallenge.classList.remove('d-none-fadeout');
      }
    }
  }
}

// not used
function displayIlluminationOverlay(colors, i) {
  // show illumination. overlay
  illuminationOverlay.style.backgroundColor = colors[i];
  illuminationOverlay.classList.remove('d-none');
  if (client) client.colorDisplayed();
  // switch illumination overlay color
  setTimeout(() => {
    illuminationOverlay.classList.add('d-none');
    if (colors[i + 2]) displayIlluminationOverlay(colors, i + 2);
  }, colors[i + 1]);
}

document.querySelector('#takeMyPickture').addEventListener('click', () => {
  selfieInput.click();
});
selfieInput.addEventListener('change', (e) => {
  commonutils.pushFaceAndDoMatch(basePath, sessionId, bestImageId, e.target.files[0]);
});

if (isVideoTutEnabled) {
  document.querySelector('main').classList.remove('animation-tut');
  document.querySelector('main').classList.add('video-tut');
  document.querySelector('#step-1-vid').id = 'step-1';
  document.querySelector('#step-end-tutorial-vid').id = 'step-end-tutorial';
} else {
  document.querySelector('#step-1-anim').id = 'step-1';
  document.querySelector('#step-end-tutorial-anim').id = 'step-end-tutorial';
}
if (document.querySelector('#step-1')) {
  window.envBrowserOk && document.querySelector('#step-1').classList.remove('d-none');
}
sessionStorage.removeItem('livenessResult');
/**
 * check user connectivity (latency, download speed, upload speed)
 */
window.onload = () => {
  if (BioserverNetworkCheck && window.envBrowserOk) {
    let ttlInProgress = window.setTimeout(() => {
      onNetworkCheckUpdate();
    }, 10000);
    let displayGoodSignal = false;

    function onNetworkCheckUpdate(networkConnectivity) {
      if (!ttlInProgress) return;
      if (!networkConnectivity || !networkConnectivity.goodConnectivity) {
        if (!networkConnectivity) {
          console.log('Unable to check user connectivity within 10sec.');
        }
        const weakNetworkCheckPage = document.querySelector('#step-weak-network');
        weakNetworkCheckPage.querySelector('.animation').classList.add('d-none');
        weakNetworkCheckPage.querySelector('.check-phone').classList.remove('d-none');
        weakNetworkCheckPage.querySelector('.upload').classList.add('d-none');
        weakNetworkCheckPage.querySelector('.download').classList.add('d-none');

        document.querySelectorAll('.step').forEach((s) => s.classList.add('d-none'));
        weakNetworkCheckPage.classList.remove('d-none');
        if (networkConnectivity) {
          const uploadNotGood = !networkConnectivity.upload ? true : (networkConnectivity.upload < BioserverNetworkCheck.UPLOAD_SPEED_THRESHOLD);
          const signalValue = networkConnectivity.upload;
          const signalThreshold = BioserverNetworkCheck.UPLOAD_SPEED_THRESHOLD;
          weakNetworkCheckPage.querySelector('.signal-value').innerHTML = (signalValue && '(' + signalValue + ' kb/s)') || '';
          weakNetworkCheckPage.querySelector('.signal-min-value').innerHTML = signalThreshold + ' kb/s';
          if (uploadNotGood) weakNetworkCheckPage.querySelector('.upload').classList.remove('d-none');
        } else { // << case of time out
          weakNetworkCheckPage.querySelector('.signal-value').innerHTML = '';
          weakNetworkCheckPage.querySelector('.signal-min-value').innerHTML = BioserverNetworkCheck.UPLOAD_SPEED_THRESHOLD + ' kb/s';
          weakNetworkCheckPage.querySelector('.upload').classList.remove('d-none');
        }
        // close VideoCapture If Needed;
        resetLivenessDesign();
        if (client) {
          client.disconnect();
        }
      } else if (networkConnectivity &&
        displayGoodSignal &&
        networkConnectivity.goodConnectivity &&
        networkConnectivity.upload) {
        document.querySelectorAll('.step').forEach(s => s.classList.add('d-none'));
        const goodNetworkCheckPage = document.querySelector('#step-good-network');
        goodNetworkCheckPage.classList.remove('d-none');
        goodNetworkCheckPage.querySelector('.signal-value').innerHTML = '(' + networkConnectivity.upload + ' kb/s)';
        goodNetworkCheckPage.querySelector('.signal-min-value').innerHTML = BioserverNetworkCheck.UPLOAD_SPEED_THRESHOLD + ' kb/s';
        displayGoodSignal = false;
        connectivityOK = true; // connectivity results retrived enough (page displayed)
      } else {
        connectivityOK = true; // connectivity results retrived enough
      }
      if (!connectivityOK) { // clear the other waiting screen since we are going to show data from network event
        clearTimeout(timeoutCheckConnectivity); // clear the timeout connectivity check
        document.querySelector('#connectivity-check').classList.add('d-none'); // hide the waiting page
      }
      ttlInProgress = window.clearTimeout(ttlInProgress);
    }

    BioserverNetworkCheck.connectivityMeasure({
      downloadURL: videoUrlWithBasePath + '/network-speed',
      uploadURL: videoUrlWithBasePath + '/network-speed',
      latencyURL: videoUrlWithBasePath + '/network-latency',
      onNetworkCheckUpdate: onNetworkCheckUpdate
    });
    document.querySelector('#check-network').onclick = function () {
      const weakNetworkCheckPage = document.querySelector('#step-weak-network');
      weakNetworkCheckPage.querySelector('.animation').classList.remove('d-none');
      weakNetworkCheckPage.querySelector('.check-phone').classList.add('d-none');
      ttlInProgress = window.setTimeout(() => {
        onNetworkCheckUpdate();
      }, 10000);
      displayGoodSignal = true;
      window.setTimeout(() => {
        BioserverNetworkCheck.connectivityMeasure({
          downloadURL: videoUrlWithBasePath + '/network-speed',
          uploadURL: videoUrlWithBasePath + '/network-speed',
          latencyURL: videoUrlWithBasePath + '/network-latency',
          onNetworkCheckUpdate: onNetworkCheckUpdate
        });
      }, 100);
    };
  }
};

/**
 init liveness animations from json files (instead pf GIFs)
 */
function initLivenessAnimations() {
  document.querySelectorAll('.animation-part1').forEach((anim) => {
    lottie.loadAnimation({
      container: anim, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_part1.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-part1-pc').forEach((anim) => {
    lottie.loadAnimation({
      container: anim, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_part1_pc.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-part2').forEach((anim) => {
    lottie.loadAnimation({
      container: anim, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_part2.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-part2-pc').forEach((anim) => {
    lottie.loadAnimation({
      container: anim, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_part2_pc.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-part3').forEach(anim => {
    lottie.loadAnimation({
      container: anim, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_part3.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-part3-pc').forEach(anim => {
    lottie.loadAnimation({
      container: anim, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_part3_pc.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-full').forEach((animationFull) => {
    lottie.loadAnimation({
      container: animationFull, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_full.json') // the animation data
    });
  });
  document.querySelectorAll('.animation-full-pc').forEach((animationFull) => {
    lottie.loadAnimation({
      container: animationFull, // the dom element that will contain the animation
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: require('./animations/liveness_animation_full_pc.json') // the animation data
    });
  });
}

initLivenessAnimations();
