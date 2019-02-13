/*
 * Authored by Runpeng Liu,
 * Brain Power (2018)
 */

const aws = require('aws-sdk');
aws.config.update({ region: process.env.AWS_REGION });
const kinesis = new aws.Kinesis();

// This function is triggered when new raw records are available
// from the output of Rekognition stream processor.
// For data specification, see: https://docs.aws.amazon.com/rekognition/latest/dg/streaming-video-kinesis-output.html
exports.handler = (event, context, callback) => {
    var records = event.Records;
    records.forEach((record) => {
        // Kinesis data is base64 encoded so decode here
        const payload = new Buffer(record.kinesis.data, 'base64').toString('ascii');
        var data = JSON.parse(payload);
        record.data = data;
    });
    // Filter for records that contain a detected face.
    var faceRecords = records.filter((record) => {
        return record.data.FaceSearchResponse && record.data.FaceSearchResponse.length;
    });
    if (faceRecords.length < 2) {
        return callback(null, `Not enough records to process.`);
    }
    // Do post-processing on detected faces.
    faceRecords.forEach((record, index) => {
        var prev = (index == 0) ? 0 : index - 1;
        var prevRecord = faceRecords[prev];
        var faceIndex = 0;
        var previousFace = prevRecord.data.FaceSearchResponse[faceIndex].DetectedFace;
        var detectedFace = record.data.FaceSearchResponse[faceIndex].DetectedFace;
        detectedFace.RecordIndex = index;
        processDetectedFace(detectedFace, previousFace, record.data.InputInformation.KinesisVideo);
    });

    faceRecords.shift();

    putRecordsIntoProcessedStream(faceRecords).then(function() {
        var firstFace = faceRecords[0];
        var lastFace = faceRecords[faceRecords.length - 1];
        console.log(`Processed ${faceRecords.length} face records. Start: ${firstFace.data.FaceSearchResponse[0].DetectedFace.Timestamp}; End: ${lastFace.data.FaceSearchResponse[0].DetectedFace.Timestamp}`);
        callback(null, `Processing complete.`);
    }).catch(callback);
};

// Computes the position of face center based on BoundingBox data.
// Modify for custom use case.
function processDetectedFace(face, previousFace, inputInfo) {
    var centerX = face.BoundingBox.Left + face.BoundingBox.Width / 2;
    var centerY = face.BoundingBox.Top + face.BoundingBox.Height / 2;
    face.BoundingBox.Center = [centerX, centerY];
    face.Timestamp = Math.min(inputInfo.ProducerTimestamp + inputInfo.FrameOffsetInSeconds, inputInfo.ProducerTimestamp + face.RecordIndex);

    // Estimate rotational and translational velocities
    // of faces in successive frames using basic first-order derivative approximation.
    var deltaTime = face.Timestamp - previousFace.Timestamp;
    if (deltaTime === 0) return;
    var deltaPosition = Math.sqrt(
      Math.pow(face.BoundingBox.Center[0] - previousFace.BoundingBox.Center[0], 2) +
      Math.pow(face.BoundingBox.Center[1] - previousFace.BoundingBox.Center[1], 2)
    );
    var faceLength = Math.sqrt(Math.pow(face.BoundingBox.Height, 2) + Math.pow(face.BoundingBox.Width, 2));
    face.TranslationalVelocity = (deltaPosition / faceLength) / deltaTime;
    var deltaRotation = Math.sqrt(
      Math.pow(face.Pose.Pitch - previousFace.Pose.Pitch, 2) +
      Math.pow(face.Pose.Roll  - previousFace.Pose.Roll,  2) +
      Math.pow(face.Pose.Yaw   - previousFace.Pose.Yaw,   2)
    );
    face.RotationalVelocity = deltaRotation / deltaTime;
}

// Put processed body motion metrics into downstream KDS
function putRecordsIntoProcessedStream(records) {
    var packagedRecords = records.map((record) => {
        return {
            Data: JSON.stringify(record.data),
            PartitionKey: 'shard-0'
        };
    });
    return new Promise(function(resolve, reject) {
        kinesis.putRecords({
            Records: packagedRecords,
            StreamName: process.env.KDS_PROCESSED_STREAM_NAME
        }, function(err, data) {
            return err ? reject(err) : resolve(data);
        });
    });
}
